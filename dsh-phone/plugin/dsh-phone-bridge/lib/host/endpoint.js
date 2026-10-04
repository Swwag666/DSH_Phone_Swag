/**
 * Файл обнаружения моста: `<DSH_HOME>/dsh-phone/bridge/endpoint.json`.
 *
 * Узел dsh-phone (Rust) читает ровно этот путь и ожидает поля
 * version/host/port/token/pid — порядок ключей и компактная сериализация
 * зафиксированы, чтобы файл можно было сравнивать побайтово в тестах.
 *
 * Все файловые операции принимают инжектируемый `fs`, поэтому логика пути,
 * сериализации и «не укради чужой endpoint» проверяется тестами без диска.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { record } from "./errors.js";

export const ENDPOINT_VERSION = 1;
export const ENDPOINT_HOST = "127.0.0.1";
/** Каталог, в который разрешено писать. Всё остальное — за пределами моста. */
export const BRIDGE_SUBPATH = ["dsh-phone", "bridge"];

export const defaultFs = { mkdir, readFile, rename, unlink, writeFile };

/** DSH_HOME: конфиг плагина важнее переменной окружения, та важнее ~/.dsh. */
export function resolveDshHome(config) {
	const home = record(config).dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	if (typeof home !== "string" || !home.trim()) throw new Error("DSH_HOME должен быть непустым путём");
	if (!isAbsolute(home)) throw new Error("DSH_HOME должен быть абсолютным путём");
	return home;
}

export function endpointPath(home) {
	return join(home, ...BRIDGE_SUBPATH, "endpoint.json");
}

/** Компактная запись в фиксированном порядке ключей. */
export function serializeEndpoint(endpoint) {
	return JSON.stringify({
		version: ENDPOINT_VERSION,
		host: ENDPOINT_HOST,
		port: endpoint.port,
		token: endpoint.token,
		pid: endpoint.pid
	});
}

export function buildEndpoint({ port, token, pid = process.pid }) {
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Порт моста вне допустимого диапазона");
	if (typeof token !== "string" || !token) throw new Error("Токен моста обязателен");
	return { version: ENDPOINT_VERSION, host: ENDPOINT_HOST, port, token, pid };
}

/** Разбор файла; отсутствие файла — это undefined, а не ошибка. */
export function parseEndpoint(text) {
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== "object") return void 0;
		return value;
	} catch {
		// Побитый файл нельзя считать «живым» владельцем: иначе мост навсегда
		// откажется стартовать после аварийного завершения DSH.
		return void 0;
	}
}

/**
 * Жив ли процесс. `process.kill(pid, 0)` не отправляет сигнал, а только
 * проверяет существование; ESRCH — процесса нет, EPERM — процесс есть, но чужой
 * (для нас это тоже «занято»).
 */
export function processAlive(pid) {
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return record(error).code !== "ESRCH";
	}
}

async function readEndpoint(path, fs) {
	try {
		return parseEndpoint(await fs.readFile(path, "utf8"));
	} catch (error) {
		if (record(error).code === "ENOENT") return void 0;
		throw error;
	}
}

/**
 * Атомарная публикация endpoint.json.
 *
 * Последовательность важна:
 *  1. каталог 0o700 — токен не должен читаться другими пользователями;
 *  2. если файл уже есть и его pid жив — НЕ трогаем (иначе два DSH начнут
 *     драться за один телефон, а первый потеряет канал без причины);
 *  3. протухший файл удаляем;
 *  4. пишем во временный файл с флагом "wx" и переименовываем — читатель
 *     никогда не увидит наполовину записанный JSON.
 */
export async function publishEndpoint(path, endpoint, fs = defaultFs) {
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const existing = await readEndpoint(path, fs);
	if (existing) {
		if (processAlive(existing.pid)) {
			throw new Error(`Другой процесс DSH (pid ${existing.pid}) уже владеет endpoint ${path}. Закройте его или укажите другой DSH_HOME.`);
		}
		await fs.unlink(path).catch((error) => {
			if (record(error).code !== "ENOENT") throw error;
		});
	}
	const temporary = `${path}.${endpoint.token}.tmp`;
	const body = serializeEndpoint(endpoint);
	try {
		await fs.writeFile(temporary, body, { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, path);
	} finally {
		await fs.unlink(temporary).catch(() => void 0);
	}
	return body;
}

/**
 * Снятие публикации. Удаляем только «свой» файл: если нас уже заменил другой
 * процесс, стирание чужого endpoint оставило бы телефон без моста.
 */
export async function releaseEndpoint(path, endpoint, fs = defaultFs) {
	const current = await readEndpoint(path, fs);
	if (!current) return false;
	if (current.token !== endpoint.token || current.pid !== endpoint.pid) return false;
	await fs.unlink(path).catch(() => void 0);
	return true;
}
