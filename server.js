const express = require("express");
const multer = require("multer");
const upload = multer();
const cors = require("cors");

const { PassThrough } = require("stream");
const ffmpegStatic = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");

const fs = require("fs");
const path = require("path");

ffmpeg.setFfmpegPath(ffmpegStatic);

const VIDEO_DIR = path.join(__dirname, "videos");
const OUTPUT_DIR = path.join(__dirname, "flux");
const INTERLUDE_FILE = path.join(VIDEO_DIR, "interlude.mp4");
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 25;
const PORT = 3000;

let currentCommand = null; // commande ffmpeg de lecture en cours
let encoderInputStream = null; // flux alimentant l'encodeur HLS permanent
let encoderCommand = null; // commande ffmpeg de l'encodeur permanent

const state = {
	status: "idle", // playing | stopped | idle
	running: true, // false = diffusion en pause ("stop")
	// Liste d'éléments { source, overlay } (normalisée juste après la déclaration)
	queue: [
  		'/Users/julie/Documents/Eiga No Neko TV/videos/Sign On.mp4',
  		'/Users/julie/Documents/Eiga No Neko TV/videos/Sign On Bumper.mp4',
  		'/Users/julie/Documents/Eiga No Neko TV/videos/interlude.mp4',
	],
	index: 0, // position courante dans la queue
	currentFile: null, // source en cours de lecture
	currentOverlay: null, // overlay de la vidéo en cours
	isInterlude: false, // true quand la file est vide et que l'interlude tourne
	currentDuration: 0, // durée (s) de la vidéo en cours
	startedAt: null, // timestamp de démarrage de la vidéo en cours
	lastError: null,

	// Overlay PAR DÉFAUT (appliqué aux vidéos ajoutées sans overlay précisé)
	overlay: {
		enabled: true,
		file: path.join(VIDEO_DIR, "overlay.png"),
		x: 0,
		y: 0,
		opacity: 0, // 0 (invisible) -> 1 (opaque)
	},
};

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

function isRemoteUrl(source) { return /^https?:\/\//i.test(source); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function labelOf(str) { return str; }

// Convertit les valeurs reçues (strings en multipart/urlencoded) et fusionne avec une base
function parseOverlay(input = {}, base = state.overlay) {
	const o = { ...base };

	if (input.enabled !== undefined) {
		o.enabled = input.enabled === true || input.enabled === "true" || input.enabled === "1" || input.enabled === "on";
	}
	if (input.file) {
		o.file = path.isAbsolute(input.file) ? input.file : path.join(VIDEO_DIR, input.file);
	}
	if (input.x !== undefined && input.x !== "" && !isNaN(parseInt(input.x))) o.x = parseInt(input.x);
	if (input.y !== undefined && input.y !== "" && !isNaN(parseInt(input.y))) o.y = parseInt(input.y);
	if (input.opacity !== undefined && input.opacity !== "" && !isNaN(parseFloat(input.opacity))) {
		o.opacity = Math.max(0, Math.min(1, parseFloat(input.opacity)));
	}
	return o;
}

// Un élément de queue = { source, overlay }
function makeItem(source, overlayInput = {}) {
	return { source, overlay: parseOverlay(overlayInput) };
}

function publicOverlay(o) {
	return { ...o, file: path.basename(o.file), exists: fs.existsSync(o.file) };
}

function publicQueue() {
	return state.queue.map((i) => ({ source: i.source, overlay: publicOverlay(i.overlay) }));
}

// Normalise la queue initiale (strings -> objets)
state.queue = state.queue.map((s) => (typeof s === "string" ? makeItem(s) : s));

function killCurrentPlayback() {
	if (currentCommand) currentCommand.kill("SIGKILL");
}

function startEncoder() {
	encoderInputStream = new PassThrough();

	encoderCommand = ffmpeg(encoderInputStream)
		.inputOptions(["-fflags", "+genpts"])
		.inputFormat("mpegts")
		.videoCodec("libx264")
		.outputOptions([
			"-preset", "veryfast",
			"-profile:v", "high",
			"-level", "4.0",
			"-pix_fmt", "yuv420p",
			"-r", String(FPS),
			"-g", String(FPS * 2),
			"-keyint_min", String(FPS * 2),
			"-c:a", "aac",
			"-b:a", "192k",
			"-ar", "48000",
			"-hls_time", "6",
			"-hls_list_size", "8",
			"-hls_flags", "delete_segments+append_list",
		])
		.output(path.join(OUTPUT_DIR, "index.m3u8"))
		.on("start", () => console.log("[Encodeur] démarré"))
		.on("stderr", () => {}) // silencieux (trop verbeux sinon)
		.on("error", (err) => {
			console.error("[Encodeur] erreur :", err.message);
			state.lastError = err.message;
			setTimeout(startEncoder, 1000);
		})
		.on("end", () => {
			console.log("[Encodeur] arrêté, redémarrage...");
			setTimeout(startEncoder, 500);
		});

	encoderCommand.run();
}

// Écran noir de secours (fichier introuvable) : dure 3 s puis rend la main au scheduler
function playBlackScreenGenerated(resolve, duration = 3) {
	console.log("[Fallback] 🎬 Génération écran noir en direct");

	const command = ffmpeg()
		.input(`color=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${duration}`)
		.inputOptions(["-re", "-f", "lavfi"])
		.videoCodec("libx264")
		.outputOptions([
			"-preset", "veryfast",
			"-pix_fmt", "yuv420p",
			"-r", String(FPS),
			"-c:a", "aac",
			"-b:a", "192k",
			"-ar", "48000",
		])
		.format("mpegts");

	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		currentCommand = null;
		resolve();
	};

	command.on("error", (err) => {
		if (!err.message.includes("SIGKILL") && !err.message.includes("was killed")) {
			console.error("[Écran noir] erreur :", err.message);
		}
		finish();
	});
	command.on("end", finish);

	const outStream = command.pipe(undefined, { end: false });
	outStream.on("data", (chunk) => {
		if (encoderInputStream && encoderInputStream.writable) {
			encoderInputStream.write(chunk);
		}
	});

	currentCommand = command;
}

// item = { source, overlay }
function playFile(item) {
	return new Promise((resolve) => {
		const source = item.source;
		const overlay = item.overlay;

		state.currentFile = source;
		state.currentOverlay = overlay;
		state.startedAt = Date.now();
		state.status = "playing";
		state.currentDuration = 0;
		state.lastError = null;

		// Vérifier d'abord si la source est accessible
		const isUrl = isRemoteUrl(source);
		const isLocal = !isUrl && fs.existsSync(source);

		if (!isUrl && !isLocal) {
			console.error("[Lecture] ❌ Fichier introuvable :", source);
			state.lastError = `Fichier introuvable : ${source}`;
			playBlackScreenGenerated(resolve);
			return;
		}

		console.log("[Lecture]", labelOf(source), state.isInterlude ? "(interlude)" : "");

		// Récupère la durée pour le calcul de progression
		ffmpeg.ffprobe(source, (err, data) => {
			if (!err && data && data.format) state.currentDuration = data.format.duration || 0;
		});

		const command = ffmpeg(source).inputOptions(["-re"]);

		// Overlay propre à cette vidéo
		const useOverlay = overlay.enabled && fs.existsSync(overlay.file);

		if (useOverlay) {
			command.input(overlay.file);
			command.complexFilter([
				{ filter: "scale", options: `${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease`, inputs: "0:v", outputs: "scaled" },
				{ filter: "pad", options: `${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`, inputs: "scaled", outputs: "base" },
				{ filter: "scale", options: `${WIDTH}:${HEIGHT}`, inputs: "1:v", outputs: "ov_scaled" },
				{ filter: "format", options: "rgba", inputs: "ov_scaled", outputs: "ov_rgba" },
				{ filter: "colorchannelmixer", options: `aa=${overlay.opacity}`, inputs: "ov_rgba", outputs: "ov_final" },
				{ filter: "overlay", options: `${overlay.x}:${overlay.y}`, inputs: ["base", "ov_final"] },
			]);
		} else {
			// Sans overlay : scaling simple
			command.videoFilters([
				`scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease`,
				`pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
			]);
		}

		command
			.outputOptions([
				"-r", String(FPS),
				"-c:v", "libx264",
				"-preset", "veryfast",
				"-pix_fmt", "yuv420p",
				"-c:a", "aac",
				"-b:a", "192k",
				"-ar", "48000",
			])
			.format("mpegts");

		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			currentCommand = null;
			resolve();
		};

		command.on("error", (err) => {
			if (err.message && !err.message.includes("SIGKILL") && !err.message.includes("was killed")) {
				console.error("[Lecture] erreur :", err.message);
				state.lastError = err.message;
			}
			finish();
		});
		command.on("end", finish);

		const outStream = command.pipe(undefined, { end: false });
		outStream.on("data", (chunk) => {
			if (encoderInputStream && encoderInputStream.writable) {
				encoderInputStream.write(chunk);
			}
		});

		currentCommand = command;
	});
}

async function scheduler() {
	while (true) {
		const item = state.queue[0];

		if (item) {
			state.isInterlude = false;
			await playFile(item);
			if (state.queue[0] === item) state.queue.shift();
		} else {
			// Plus rien en file : interlude (sans overlay)
			state.isInterlude = true;
			await playFile({
				source: INTERLUDE_FILE,
				overlay: { ...state.overlay, enabled: false },
			});
		}

		await sleep(100); // évite une boucle folle en cas d'erreur répétée
	}
}

startEncoder();
setTimeout(scheduler, 1000);

const app = express();
app.use(cors());
app.use(express.json());

app.use("/flux", express.static(OUTPUT_DIR));

// Ajout à la queue, avec overlay propre à la vidéo
app.post("/api/queue", upload.none(), (req, res) => {
	const { source, overlay_file, overlay_enabled, overlay_opacity, overlay_x, overlay_y } = req.body || {};

	if (!source || typeof source !== "string") {
		return res.status(400).json({ ok: false, error: "Paramètre 'source' requis (URL ou nom de fichier)" });
	}

	const item = makeItem(source, {
		file: overlay_file,
		enabled: overlay_enabled,
		opacity: overlay_opacity,
		x: overlay_x,
		y: overlay_y,
	});
	state.queue.push(item);

	// Si on était sur l'interlude, on le coupe pour passer à la nouvelle vidéo
	if (state.isInterlude) killCurrentPlayback();

	res.json({
		ok: true,
		message: "Vidéo ajoutée à la file d'attente",
		queue: publicQueue(),
	});
});

app.get("/api/queue", (req, res) => {
	res.json(publicQueue());
});

app.post("/api/control", upload.none(), (req, res) => {
	const { action } = req.body || {};
	switch (action) {
		case "next":
			killCurrentPlayback();
			res.json({ ok: true, message: "Passage à la vidéo suivante" });
			break;
		default:
			res.status(400).json({ ok: false, error: "Action inconnue" });
	}
});

// Modifie l'overlay PAR DÉFAUT (nouvelles vidéos), ou celui d'une vidéo en attente via "index"
// (une modification ne s'applique pas à la vidéo déjà en cours de lecture)
app.post("/api/overlay", upload.none(), (req, res) => {
	const { index, ...rest } = req.body || {};

	if (index !== undefined && state.queue[parseInt(index)]) {
		const item = state.queue[parseInt(index)];
		item.overlay = parseOverlay(rest, item.overlay);
		return res.json({ ok: true, overlay: publicOverlay(item.overlay) });
	}

	state.overlay = parseOverlay(rest, state.overlay);
	res.json({ ok: true, overlay: publicOverlay(state.overlay) });
});

app.get("/api/overlay", (req, res) => {
	res.json({ ok: true, overlay: publicOverlay(state.overlay) });
});

app.get("/api/status", (req, res) => {
	const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;

	res.json({
		status: state.status,
		running: state.running,
		file: state.currentFile ? path.basename(state.currentFile) : null,
		elapsed: Math.round(elapsed),
		duration: Math.round(state.currentDuration),
		position: state.currentDuration ? Math.min(1, elapsed / state.currentDuration) : 0,
		queueLength: state.queue.length,
		overlay: publicOverlay(state.currentOverlay || state.overlay),
		interlude: state.isInterlude,
		lastError: state.lastError,
	});
});

app.listen(PORT, "127.0.0.1", () => {
	console.log(`Flux HLS : http://127.0.0.1:${PORT}/flux/index.m3u8`);
});