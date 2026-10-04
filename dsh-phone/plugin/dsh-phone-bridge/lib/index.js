/**
 * dsh-phone-bridge, хостовая половина (главный процесс Node/Electron).
 *
 * Задача: поднять loopback TCP JSON-RPC мост, совместимый по проводам с мостом
 * Agents Anywhere, чтобы узел dsh-phone (Rust) работал БЕЗ плагина AA. Rust-код
 * менять нельзя, поэтому протокол, коды ошибок и формы ответов повторяют AA.
 *
 * Этот файл намеренно тонкий: вся логика живёт в ./host/*, а здесь только
 * регистрация сервиса Cordis и его жизненный цикл.
 */
import { Service } from "@deepseek-ai/cordis";
import { endpointPath, resolveDshHome } from "./host/endpoint.js";
import { createLogger, NativeRuntime } from "./host/native.js";
import { RuntimeServer } from "./host/server.js";

export const name = "dsh-phone-bridge";

/** Версия попадает в identity ответа initialize: её видит телефон и /api/health.
 *  Держим синхронно с version в package.json и с релизным поездом продукта:
 *  подпись апдейтера требует совпадения версии, поэтому вперёд релиза не поднимаем. */
export const version = "0.4.0";

/** Пауза и число повторов старта: порт или права могли быть заняты временно. */
const RESTART_DELAY_MS = 5_000;
const MAX_RESTART_ATTEMPTS = 3;

export class DshPhoneBridgeService extends Service {
	static inject = ["sessions", "sessionQuery", "workspaceRegistry"];

	server;
	native;
	logger;
	disposed = false;
	restartTimer;
	restartAttempts = 0;

	constructor(ctx, config) {
		super(ctx, "dshPhoneBridge");
		// DSH_HOME обязан быть абсолютным: относительный путь зависел бы от cwd
		// процесса Electron, а endpoint.json читает совсем другой процесс (узел).
		const home = resolveDshHome(config);
		this.logger = createLogger(ctx);
		this.native = new NativeRuntime(ctx, this.logger);
		this.server = new RuntimeServer({
			endpointPath: endpointPath(home),
			native: this.native,
			logger: this.logger,
			version
		});
		ctx.effect(() => async () => {
			this.disposed = true;
			if (this.restartTimer) clearTimeout(this.restartTimer);
			this.restartTimer = void 0;
			// Порядок важен: сначала закрываем транспорт (клиенты получают обрыв
			// и не ждут ответов), потом освобождаем нативные ресурсы DSH.
			await this.server.close().catch((error) => this.logger.warn("ошибка остановки сервера моста", { error: String(error) }));
			await this.native.close().catch((error) => this.logger.warn("ошибка остановки рантайма моста", { error: String(error) }));
		}, "dshPhoneBridge.close");
	}

	async [Service.init]() {
		await this.start();
	}

	/**
	 * Старт без проброса исключения наружу.
	 *
	 * Если мост не поднялся (занят endpoint, нет прав на каталог), падать должен
	 * мост, а не весь DSH Desktop: плагин остаётся загруженным и повторяет
	 * попытку, а пользователь видит причину в логе.
	 */
	async start() {
		try {
			await this.server.start();
			this.restartAttempts = 0;
			return true;
		} catch (error) {
			this.logger.error("мост dsh-phone не запустился", { error: String(error) });
			this.scheduleRestart();
			return false;
		}
	}

	scheduleRestart() {
		if (this.disposed || this.restartTimer || this.restartAttempts >= MAX_RESTART_ATTEMPTS) return;
		this.restartAttempts++;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			if (this.disposed) return;
			this.start();
		}, RESTART_DELAY_MS);
		// Таймер не должен держать процесс живым при закрытии DSH.
		this.restartTimer.unref?.();
	}

	/** Диагноз для логов/отладки: что именно опубликовано как endpoint. */
	endpoint() {
		return this.server.endpoint ?? null;
	}
}

export function apply(ctx, config) {
	ctx.plugin(DshPhoneBridgeService, config);
}
