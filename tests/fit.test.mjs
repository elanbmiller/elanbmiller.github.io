// Checks that the homepage fits the browser window without scrolling, at common screen sizes and after resizing.
// Drives headless Chromium over the DevTools protocol; needs Node 22+ (built-in WebSocket) and Chromium or Chrome.
// Usage: node tests/fit.test.mjs [page]   e.g. node tests/fit.test.mjs /index.html

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PAGE = process.argv[2] || "/index.html";

const SIZES = [
	[2560, 1300], [1920, 1080], [1920, 950], [1536, 864], [1440, 900], [1366, 768],
	[1280, 800], [1280, 600], [1024, 768], [768, 1024], [390, 844], [360, 640], [844, 390],
];
// Loaded at the first size, then resized through the rest without reloading.
const RESIZES = [[1920, 1080], [1280, 600], [1920, 1080], [390, 844]];

// Runs inside the page; returns [label, ok, detail] for each check.
const CHECKS = () => {
	const root = document.documentElement;
	const w = innerWidth, h = innerHeight;
	const name = document.getElementById("myName");
	const size = parseFloat(getComputedStyle(name).fontSize);
	const links = document.querySelectorAll("nav a");
	const lastLink = links[links.length - 1].getBoundingClientRect();
	const results = [
		["no vertical scroll", root.scrollHeight <= h, `content ${root.scrollHeight}px > ${h}px`],
		["no horizontal scroll", root.scrollWidth <= w, `content ${root.scrollWidth}px > ${w}px`],
		["Resume link fully on screen", lastLink.bottom <= h, `bottom at ${Math.round(lastLink.bottom)}px`],
		["name no bigger than the width-based size", size <= w / 5 + 0.5, `${size}px > ${w / 5}px`],
	];
	// The name should only shrink as much as needed: if it's below the width-based size, slightly bigger must overflow.
	if (size < w / 5 - 0.5) {
		const before = name.style.fontSize;
		root.style.overflow = "hidden";
		name.style.fontSize = size + 2 + "px";
		const tight = root.scrollHeight > h;
		name.style.fontSize = before;
		root.style.overflow = "";
		results.push(["name not shrunk more than needed", tight, `${size}px + 2px still fits`]);
	}
	return results;
};

// --- static file server for the repo ---
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf" };
const server = createServer(async (req, res) => {
	try {
		const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
		const body = await readFile(join(ROOT, path));
		res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" }).end(body);
	} catch {
		res.writeHead(404).end();
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// --- headless Chromium over the DevTools protocol ---
const chromePath = ["chromium", "chromium-browser", "google-chrome"].find((c) => {
	try { execSync(`command -v ${c}`, { stdio: "ignore" }); return true; } catch { return false; }
});
if (!chromePath) { console.error("Chromium/Chrome not found"); process.exit(2); }

const chrome = spawn(chromePath, ["--headless", "--disable-gpu", "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
	let err = "";
	chrome.stderr.on("data", (d) => {
		err += d;
		const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
		if (m) resolve(m[1]);
	});
	chrome.on("exit", () => reject(new Error("Chromium exited:\n" + err)));
});
const browserPort = new URL(wsUrl).port;
const target = (await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json()).find((t) => t.type === "page");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
const listeners = new Set();
ws.addEventListener("message", (e) => {
	const msg = JSON.parse(e.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
	} else listeners.forEach((fn) => fn(msg));
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
	const { result, exceptionDetails } = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
	if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
	return result.value;
};
const waitForEvent = (method) => new Promise((resolve) => {
	const fn = (msg) => { if (msg.method === method) { listeners.delete(fn); resolve(msg); } };
	listeners.add(fn);
});

await send("Page.enable");
const setSize = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
// Wait for web fonts and two rendered frames so the page's own resizing has run.
const settle = () => evaluate("document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))");
const load = async () => {
	const loaded = waitForEvent("Page.loadEventFired");
	await send("Page.navigate", { url: BASE + PAGE });
	await loaded;
	await settle();
};

let passed = 0, failed = 0;
const report = async (label) => {
	for (const [check, ok, detail] of await evaluate(`(${CHECKS})()`)) {
		ok ? passed++ : failed++;
		console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${check}${ok ? "" : ` (${detail})`}`);
	}
};

try {
	for (const [w, h] of SIZES) {
		await setSize(w, h);
		await load();
		await report(`${w}x${h}`);
	}

	await setSize(...RESIZES[0]);
	await load();
	for (const [w, h] of RESIZES.slice(1)) {
		await setSize(w, h);
		await settle();
		await report(`after resizing to ${w}x${h}`);
	}
} catch (e) {
	failed++;
	console.log(`FAIL error: ${e.message}`);
} finally {
	ws.close();
	chrome.kill();
	server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
