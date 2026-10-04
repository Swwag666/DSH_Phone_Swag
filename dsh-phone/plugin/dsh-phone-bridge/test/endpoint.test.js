/**
 * Тесты endpoint.json: путь, сериализация, атомарная запись и правило «не укради
 * чужой endpoint». Файловая система подменяется in-memory заглушкой, поэтому
 * тесты не трогают реальный DSH_HOME и не требуют DSH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
	buildEndpoint,
	endpointPath,
	parseEndpoint,
	processAlive,
	publishEndpoint,
	releaseEndpoint,
	resolveDshHome,
	serializeEndpoint
} from "../lib/host/endpoint.js";

const HOME = join(homedir(), "dsh-endpoint-test");
const PATH = endpointPath(HOME);

function fakeFs(initial = {}) {
	const files = new Map(Object.entries(initial));
	const calls = [];
	const missing = (code = "ENOENT") => {
		const error = new Error(code);
		error.code = code;
		return error;
	};
	return {
		files,
		calls,
		async mkdir(path, options) {
			calls.push(["mkdir", path, options]);
		},
		async readFile(path) {
			if (!files.has(path)) throw missing();
			return files.get(path);
		},
		async writeFile(path, body, options) {
			calls.push(["writeFile", path, options]);
			// Флаг "wx" обязан падать на существующем файле: это защита от гонки
			// двух процессов, стартующих одновременно.
			if (options?.flag === "wx" && files.has(path)) throw missing("EEXIST");
			files.set(path, body);
		},
		async rename(from, to) {
			calls.push(["rename", from, to]);
			if (!files.has(from)) throw missing();
			files.set(to, files.get(from));
			files.delete(from);
		},
		async unlink(path) {
			calls.push(["unlink", path]);
			if (!files.has(path)) throw missing();
			files.delete(path);
		}
	};
}

test("resolveDshHome: конфиг важнее переменной окружения", () => {
	const previous = process.env.DSH_HOME;
	try {
		process.env.DSH_HOME = join(homedir(), "from-env");
		assert.equal(resolveDshHome({ dshHome: HOME }), HOME);
		assert.equal(resolveDshHome({}), join(homedir(), "from-env"));
		assert.equal(resolveDshHome(void 0), join(homedir(), "from-env"));
		delete process.env.DSH_HOME;
		assert.equal(resolveDshHome(void 0), join(homedir(), ".dsh"));
		// Относительный путь зависит от cwd процесса Electron, а endpoint.json
		// читает другой процесс: такое принимать нельзя.
		assert.throws(() => resolveDshHome({ dshHome: "relative/path" }), /абсолютным/);
		assert.throws(() => resolveDshHome({ dshHome: "" }), /непустым/);
		assert.throws(() => resolveDshHome({ dshHome: 5 }), /непустым/);
	} finally {
		if (previous === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
});

test("endpointPath указывает на dsh-phone/bridge/endpoint.json", () => {
	assert.equal(PATH, join(HOME, "dsh-phone", "bridge", "endpoint.json"));
	assert.ok(PATH.endsWith(`${sep}endpoint.json`));
	// Путь обязан лежать внутри DSH_HOME/dsh-phone: за его пределы не пишем.
	assert.ok(PATH.startsWith(join(HOME, "dsh-phone")));
});

test("serializeEndpoint даёт компактный JSON в фиксированном порядке ключей", () => {
	const endpoint = { version: 1, host: "127.0.0.1", port: 4321, token: "abc-123", pid: 4242 };
	assert.equal(serializeEndpoint(endpoint), '{"version":1,"host":"127.0.0.1","port":4321,"token":"abc-123","pid":4242}');
	assert.equal(serializeEndpoint(endpoint).includes(" "), false);
	assert.equal(serializeEndpoint(endpoint).includes("\n"), false);
	// Лишние поля наружу не уходят: узел читает файл строго по своей схеме.
	assert.equal(serializeEndpoint({ ...endpoint, extra: 1 }).includes("extra"), false);
});

test("buildEndpoint проверяет порт и токен", () => {
	const endpoint = buildEndpoint({ port: 8460, token: "t", pid: 7 });
	assert.deepEqual(endpoint, { version: 1, host: "127.0.0.1", port: 8460, token: "t", pid: 7 });
	assert.equal(buildEndpoint({ port: 1, token: "t" }).pid, process.pid);
	for (const port of [0, -1, 65536, 1.5, "8460", void 0]) {
		assert.throws(() => buildEndpoint({ port, token: "t" }), /Порт/, String(port));
	}
	assert.throws(() => buildEndpoint({ port: 1, token: "" }), /Токен/);
	assert.throws(() => buildEndpoint({ port: 1, token: 5 }), /Токен/);
});

test("parseEndpoint терпит битый и пустой файл", () => {
	assert.deepEqual(parseEndpoint('{"version":1,"port":1}'), { version: 1, port: 1 });
	assert.equal(parseEndpoint("{ не json"), void 0);
	assert.equal(parseEndpoint(""), void 0);
	assert.equal(parseEndpoint("null"), void 0);
	assert.equal(parseEndpoint("5"), void 0);
});

test("processAlive различает живой процесс и мусор", () => {
	assert.equal(processAlive(process.pid), true);
	assert.equal(processAlive(0), false);
	assert.equal(processAlive(-1), false);
	assert.equal(processAlive(Number.NaN), false);
	assert.equal(processAlive("123"), false);
	assert.equal(processAlive(void 0), false);
});

test("publishEndpoint создаёт приватный каталог и пишет атомарно", async () => {
	const fs = fakeFs();
	const endpoint = buildEndpoint({ port: 41000, token: "tok", pid: process.pid });
	await publishEndpoint(PATH, endpoint, fs);
	assert.equal(fs.files.get(PATH), serializeEndpoint(endpoint));
	const mkdir = fs.calls.find((call) => call[0] === "mkdir");
	assert.equal(mkdir[1], join(HOME, "dsh-phone", "bridge"));
	assert.deepEqual(mkdir[2], { recursive: true, mode: 0o700 });
	const write = fs.calls.find((call) => call[0] === "writeFile");
	assert.deepEqual(write[2], { flag: "wx", mode: 0o600 });
	// Запись идёт во временный файл и переименовывается: читатель не увидит
	// половину JSON.
	const rename = fs.calls.find((call) => call[0] === "rename");
	assert.equal(rename[2], PATH);
	assert.notEqual(rename[1], PATH);
	assert.equal([...fs.files.keys()].length, 1, "временный файл должен быть удалён");
});

test("publishEndpoint отказывается красть endpoint живого процесса", async () => {
	const fs = fakeFs({ [PATH]: serializeEndpoint({ version: 1, host: "127.0.0.1", port: 1, token: "чужой", pid: process.pid }) });
	await assert.rejects(
		() => publishEndpoint(PATH, buildEndpoint({ port: 2, token: "наш", pid: process.pid }), fs),
		(error) => error instanceof Error && error.message.includes(String(process.pid))
	);
	// Чужой файл не тронут.
	assert.equal(fs.files.get(PATH).includes("чужой"), true);
});

test("publishEndpoint заменяет протухший endpoint", async () => {
	// pid 0 никогда не «жив»: processAlive считает его невалидным.
	const stale = serializeEndpoint({ version: 1, host: "127.0.0.1", port: 1, token: "старый", pid: 0 });
	const fs = fakeFs({ [PATH]: stale });
	const endpoint = buildEndpoint({ port: 3, token: "новый", pid: process.pid });
	await publishEndpoint(PATH, endpoint, fs);
	assert.equal(fs.files.get(PATH), serializeEndpoint(endpoint));
	assert.ok(fs.calls.some((call) => call[0] === "unlink" && call[1] === PATH));
});

test("publishEndpoint переживает битый файл на диске", async () => {
	const fs = fakeFs({ [PATH]: "это не json" });
	const endpoint = buildEndpoint({ port: 4, token: "после-битого", pid: process.pid });
	await publishEndpoint(PATH, endpoint, fs);
	assert.equal(fs.files.get(PATH), serializeEndpoint(endpoint));
});

test("releaseEndpoint удаляет только свой файл", async () => {
	const endpoint = buildEndpoint({ port: 5, token: "наш", pid: process.pid });
	const fs = fakeFs({ [PATH]: serializeEndpoint(endpoint) });
	assert.equal(await releaseEndpoint(PATH, endpoint, fs), true);
	assert.equal(fs.files.has(PATH), false);

	const foreignPid = fakeFs({ [PATH]: serializeEndpoint({ ...endpoint, pid: process.pid + 1 }) });
	assert.equal(await releaseEndpoint(PATH, endpoint, foreignPid), false);
	assert.equal(foreignPid.files.has(PATH), true);

	const foreignToken = fakeFs({ [PATH]: serializeEndpoint({ ...endpoint, token: "уже другой" }) });
	assert.equal(await releaseEndpoint(PATH, endpoint, foreignToken), false);
	assert.equal(foreignToken.files.has(PATH), true);

	assert.equal(await releaseEndpoint(PATH, endpoint, fakeFs()), false);
});
