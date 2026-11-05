// The page: devices on the network, offers, transfers and text, drawn from the room's messages.
import qrcode from "qrcode-generator";
import type { PeerView, TransferView } from "../src/room.ts";
import { Client, type ConnState } from "./client.ts";
import { detect, formatBytes, formatEta, loadIdentity, saveIdentity } from "./device.ts";
import { dict, format, type Key, type Lang } from "./i18n.ts";

// ---------- language and theme ----------

const store = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
const get = (k: string) => {
  try {
    return store?.getItem(k) ?? null;
  } catch {
    return null;
  }
};
const set = (k: string, v: string) => {
  try {
    store?.setItem(k, v);
  } catch {}
};

let lang: Lang = document.documentElement.lang.startsWith("zh") ? "zh" : "en";
const t = (k: Key, vars?: Record<string, string | number>) => format(dict[lang][k], vars);

type Theme = "system" | "light" | "dark";
let theme: Theme = (() => {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" || v === "dark" ? v : "system";
})();

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function applyStatic(): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = t("title");
  for (const el of $$("[data-i18n]")) el.textContent = t(el.dataset.i18n as Key);
  for (const el of $$("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel as Key));
  for (const el of $$("[data-digit]")) el.setAttribute("aria-label", t("digit", { n: el.dataset.digit! }));
  $("#textBody").setAttribute("placeholder", t("textPlaceholder"));
  for (const b of $$<HTMLButtonElement>("#langSeg button")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  const word = t(theme === "system" ? "th_system" : theme === "light" ? "th_light" : "th_dark");
  $("#themeWord").textContent = word;
  $("#themeBtn").setAttribute("aria-label", t("themeLabel", { mode: word }));
  $("#themeIco").setAttribute("href", theme === "system" ? "#i-system" : theme === "light" ? "#i-sun" : "#i-moon");
}

$("#langSeg").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-lang]");
  if (!b) return;
  lang = b.dataset.lang as Lang;
  set("lan-drop.lang", lang);
  applyStatic();
  renderAll();
});

$("#themeBtn").addEventListener("click", () => {
  theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  set("lan-drop.theme", theme);
  applyStatic();
});

// ---------- state ----------

const { kind } = detect(navigator.userAgent, navigator.maxTouchPoints);
const touch = navigator.maxTouchPoints > 0;
const ident = loadIdentity(lang, store);

interface TextItem {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
}

interface Rate {
  bytes: number;
  at: number;
  rate: number;
}

const state = {
  me: null as PeerView | null,
  peers: [] as PeerView[],
  names: new Map<string, PeerView>(),
  transfers: new Map<string, TransferView>(),
  texts: [] as TextItem[],
  /** Files this page offered, by transfer id, so it can upload and retry them. */
  local: new Map<string, File[]>(),
  uploading: new Set<string>(),
  sent: new Map<string, number>(),
  rates: new Map<string, Rate>(),
  saved: new Set<string>(),
  pending: null as File[] | null,
  filter: "all" as "all" | "sent" | "received",
  view: "loading" as "loading" | "filled" | "empty" | "error" | "replaced" | "pin",
  joinUrls: [] as string[],
  lanUrls: [] as string[],
  home: true,
};

/** "Blue Fox · Linux" is shown as the name and the platform. */
function splitName(full: string): { name: string; os: string } {
  const i = full.lastIndexOf(" · ");
  return i > 0 ? { name: full.slice(0, i), os: full.slice(i + 3) } : { name: full, os: "" };
}

function peerName(id: string): string {
  const p = state.names.get(id);
  return p ? splitName(p.name).name : t("unknownDevice");
}

function track(key: string, bytes: number): Rate {
  const now = performance.now();
  const prev = state.rates.get(key);
  let rate = prev?.rate ?? 0;
  if (prev && now - prev.at > 200 && bytes >= prev.bytes) {
    const inst = ((bytes - prev.bytes) * 1000) / (now - prev.at);
    rate = rate ? rate * 0.7 + inst * 0.3 : inst;
    const r = { bytes, at: now, rate };
    state.rates.set(key, r);
    return r;
  }
  if (!prev) state.rates.set(key, { bytes, at: now, rate: 0 });
  return state.rates.get(key)!;
}

// ---------- toast ----------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function errorText(code: string): string {
  const k = `err_${code}` as Key;
  return k in dict.en ? t(k) : t("err_generic", { code });
}

// ---------- connection ----------

const client = new Client(ident, kind, {
  state(s: ConnState, detail?: string) {
    const dot = $("#connDot");
    const word = $("#connWord");
    dot.className = "dot" + (s === "online" ? "" : s === "connecting" ? " wait" : " bad");
    word.dataset.i18n = s === "online" ? "conn_ok" : s === "connecting" ? "conn_wait" : "conn_lost";
    word.textContent = t(word.dataset.i18n as Key);
    if (s === "reconnecting" && state.view !== "pin" && state.view !== "replaced") setView("error");
    if (s === "replaced") setView("replaced");
    if (s === "pin") showPin(detail === "pin_locked" ? "pinLocked" : "pinWrong");
  },
  welcome(self, peers, transfers) {
    state.me = self;
    state.peers = peers;
    for (const p of peers) state.names.set(p.id, p);
    for (const tr of transfers) state.transfers.set(tr.id, tr);
    $("#pinscreen").hidden = true;
    $("#shell").hidden = false;
    $("#me").hidden = false;
    renderMe();
    updateView();
    for (const tr of transfers) afterTransfer(tr);
  },
  peers(peers) {
    state.peers = peers;
    for (const p of peers) state.names.set(p.id, p);
    updateView();
  },
  transfer(tr) {
    state.transfers.set(tr.id, tr);
    afterTransfer(tr);
    schedule();
  },
  text(m) {
    state.texts.push({ id: m.id, from: m.from, to: m.to, text: m.text, at: m.at });
    if (m.to === ident.id) toast(`${peerName(m.from)}: ${m.text.slice(0, 80)}`);
    schedule();
  },
  error(code) {
    toast(errorText(code));
  },
});

function updateView(): void {
  if (state.view === "pin" || state.view === "replaced") return;
  setView(state.peers.length === 0 ? "empty" : "filled");
}

function setView(v: typeof state.view): void {
  state.view = v;
  const shell = $("#shell");
  shell.dataset.view = v;
  for (const part of $$("[data-view-part]")) part.hidden = part.dataset.viewPart !== v;
  renderAll();
}

// ---------- sending ----------

async function sendFiles(to: string, files: File[]): Promise<void> {
  if (files.length === 0) return;
  try {
    const id = await client.offer(to, files);
    state.local.set(id, files);
    schedule();
  } catch (e) {
    toast(errorText(e instanceof Error ? e.message : "generic"));
  }
}

/** Uploads an accepted transfer's waiting files one after another. */
async function pump(tr: TransferView): Promise<void> {
  const files = state.local.get(tr.id);
  if (!files || state.uploading.has(tr.id)) return;
  state.uploading.add(tr.id);
  try {
    for (;;) {
      const cur = state.transfers.get(tr.id);
      if (!cur || cur.state !== "accepted") break;
      const next = cur.files.find((f) => f.state === "waiting");
      if (!next) break;
      const file = files[next.idx];
      if (!file) break;
      const key = `${tr.id}:${next.idx}`;
      const up = client.upload(tr.id, next.idx, file, (sent) => {
        state.sent.set(key, sent);
        track(key, sent);
        schedule();
      });
      uploads.set(tr.id, up);
      try {
        await up.done;
      } catch (e) {
        const code = e instanceof Error ? e.message : "network";
        if (code !== "aborted" && code !== "cancelled") toast(`${file.name}: ${errorText(code)}`);
        // The server marks the file failed; wait for that message before going on.
        await new Promise((r) => setTimeout(r, 300));
        if (state.transfers.get(tr.id)?.files[next.idx]?.state !== "ready") break;
      }
    }
  } finally {
    uploads.delete(tr.id);
    state.uploading.delete(tr.id);
  }
}
const uploads = new Map<string, { abort(): void }>();

function afterTransfer(tr: TransferView): void {
  if (tr.from === ident.id && tr.state === "accepted") void pump(tr);
  if (tr.state === "cancelled" || tr.state === "declined") uploads.get(tr.id)?.abort();
  // Received files save themselves on a computer; a phone saves on a tap.
  if (tr.to === ident.id && !touch) {
    for (const f of tr.files) {
      const key = `${tr.id}:${f.idx}`;
      if (f.url && !state.saved.has(key)) {
        state.saved.add(key);
        save(f.url, f.name);
      }
    }
  }
  if (tr.to === ident.id && tr.state === "offered" && document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification(t("title"), { body: incomingTitle(tr) });
  }
}

function save(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Plain http on a LAN address is not a secure context: no clipboard API.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(t("copied"));
}

// ---------- rendering ----------

let frame = 0;
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderAll();
  });
}

const ICON: Record<string, string> = { phone: "i-phone", tablet: "i-tablet", laptop: "i-laptop", desktop: "i-desktop" };
const icon = (id: string, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}" /></svg>`;

/** Replaces a list's children by key, touching only the items whose markup changed. */
function patch(list: HTMLElement, items: { key: string; html: string }[]): void {
  const cache = ((list as any)._cache ??= new Map<string, { html: string; el: Element }>()) as Map<string, { html: string; el: Element }>;
  const keep = new Set<string>();
  let prev: Element | null = null;
  for (const it of items) {
    keep.add(it.key);
    let c = cache.get(it.key);
    if (!c || c.html !== it.html) {
      const tpl = document.createElement("template");
      tpl.innerHTML = it.html.trim();
      const el = tpl.content.firstElementChild!;
      if (c) c.el.replaceWith(el);
      c = { html: it.html, el };
      cache.set(it.key, c);
    }
    const want: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
    if (want !== c.el) list.insertBefore(c.el, want);
    prev = c.el;
  }
  for (const [k, c] of cache) if (!keep.has(k)) {
    c.el.remove();
    cache.delete(k);
  }
}

function renderMe(): void {
  const { name, os } = splitName(ident.name);
  $("#meName").textContent = name;
  $("#meOs").textContent = os;
}

function renderAll(): void {
  renderJoin();
  renderCount();
  renderIncoming();
  renderPick();
  renderGrid();
  renderTransfers();
}

function qrSvg(url: string): string {
  const q = qrcode(0, "M");
  q.addData(url);
  q.make();
  const n = q.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg class="qr" viewBox="-2 -2 ${n + 4} ${n + 4}" role="img" aria-label="${esc(t("qrLabel", { url }))}" shape-rendering="crispEdges"><path fill="currentColor" d="${d}"/></svg>`;
}

let joinKey = "";
function renderJoin(): void {
  const url = state.joinUrls[0];
  const key = `${lang}|${url ?? ""}`;
  if (key === joinKey) return;
  joinKey = key;
  // Opened through the domain from home: the LAN address is faster and needs no sign-in.
  const lan = state.lanUrls[0];
  const alt = !!lan && state.home && url !== lan;
  $("#lanAlt").hidden = !alt;
  if (alt) $("#lanAltUrl").textContent = lan.replace(/\/$/, "");
  for (const el of $$("[data-qr]")) el.innerHTML = url ? qrSvg(url) : `<p class="muted small">${esc(t("joinNoAddr"))}</p>`;
  for (const el of $$("[data-addr]")) {
    el.hidden = !url;
    if (!url) continue;
    const primary = el.hasAttribute("data-primary");
    el.innerHTML = `<code>${esc(url.replace(/\/$/, ""))}</code><button class="btn ${primary ? "btn-primary" : "btn-secondary"} btn-sm" type="button" data-copy="${esc(url)}">${icon("i-copy")}<span class="lbl">${esc(t(primary ? "copyAddress" : "copy"))}</span></button>`;
  }
}

function renderCount(): void {
  const n = state.peers.filter((p) => p.online).length;
  $("#count").hidden = state.view !== "filled";
  $("#countWord").textContent = t("onlineCount", { n });
}

function incomingTitle(tr: TransferView): string {
  const name = peerName(tr.from);
  return tr.files.length === 1 ? t("inTitleOne", { name }) : t("inTitle", { name, n: tr.files.length });
}

function renderIncoming(): void {
  const offers = [...state.transfers.values()].filter((tr) => tr.to === ident.id && tr.state === "offered");
  patch(
    $("#incoming"),
    offers.map((tr) => {
      const p = state.names.get(tr.from);
      const { os } = splitName(p?.name ?? "");
      const total = tr.files.reduce((s, f) => s + f.size, 0);
      const pink = p && (p.kind === "phone" || p.kind === "tablet") ? " pink" : "";
      const files = tr.files
        .slice(0, 8)
        .map((f) => `<li><span>${esc(f.name)}</span><span>${formatBytes(f.size)}</span></li>`)
        .join("");
      const more = tr.files.length > 8 ? `<li><span class="muted">+${tr.files.length - 8}</span><span></span></li>` : "";
      return {
        key: tr.id,
        html: `<aside class="incoming" role="dialog" aria-labelledby="in-${tr.id}" data-tid="${tr.id}">
          <div class="in-head">
            <span class="dev-ico${pink}">${icon(ICON[p?.kind ?? "desktop"]!)}</span>
            <div><h2 id="in-${tr.id}">${esc(incomingTitle(tr))}</h2>
            <p class="in-sub"><span>${esc(os)}</span><span>${formatBytes(total)}</span></p></div>
          </div>
          <ul class="in-files">${files}${more}</ul>
          <div class="in-acts">
            <button class="btn btn-secondary" type="button" data-act="decline">${esc(t("decline"))}</button>
            <button class="btn btn-primary" type="button" data-act="accept">${esc(t("accept"))}</button>
          </div>
        </aside>`,
      };
    }),
  );
}

function renderPick(): void {
  const bar = $("#pickbar");
  bar.hidden = !state.pending || state.view !== "filled";
  document.body.classList.toggle("picking", !bar.hidden);
  if (state.pending) $("#pickWord").textContent = t("pickN", { n: state.pending.length });
}

/** What a device tile says it is doing with this device right now. */
function activity(peer: string): { label: string; pct?: number; wait?: boolean; incoming?: boolean } | null {
  for (const tr of state.transfers.values()) {
    const mine = tr.from === ident.id && tr.to === peer;
    const theirs = tr.to === ident.id && tr.from === peer;
    if (!mine && !theirs) continue;
    if (mine && tr.state === "offered") return { label: t("waitingAccept"), wait: true };
    if (tr.state === "accepted") {
      const total = tr.files.reduce((s, f) => s + f.size, 0) || 1;
      const done = tr.files.reduce((s, f) => s + (f.state === "ready" ? f.size : mine ? (state.sent.get(`${tr.id}:${f.idx}`) ?? 0) : f.received), 0);
      const pct = Math.min(100, Math.floor((done / total) * 100));
      return { label: t(mine ? "sendingN" : "receivingN", { n: pct }), pct, incoming: theirs };
    }
  }
  return null;
}

function renderGrid(): void {
  patch(
    $("#grid"),
    state.peers.map((p) => {
      const { name, os } = splitName(p.name);
      const pink = p.kind === "phone" || p.kind === "tablet" ? " pink" : "";
      const act = p.online ? activity(p.id) : null;
      const st = !p.online
        ? `<span class="dev-state"><span class="dot bad"></span><span>${esc(t("offlineState"))}</span></span>`
        : act
          ? `<span class="dev-state"><span class="dot${act.wait ? " wait" : ""}"></span><span>${esc(act.label)}</span></span>`
          : "";
      const bar = act?.pct !== undefined ? `<span class="mini"><span class="fill${act.incoming ? " in" : ""}" style="width:${act.pct}%"></span></span>` : "";
      return {
        key: p.id,
        html: `<li class="tile${p.online ? "" : " is-off"}" data-peer="${esc(p.id)}">
          <button class="tile-main" type="button" data-act="send" ${p.online ? "" : "disabled"} aria-label="${esc(t("sendFilesTo", { name }))}">
            <span class="dev-ico${pink}">${icon(ICON[p.kind]!)}</span>${st}
            <span class="dev-text"><span class="dev-name">${esc(name)}</span><span class="dev-os">${esc(os)}</span></span>${bar}
          </button>
          <button class="btn btn-ghost btn-sm tile-text" type="button" data-act="text" ${p.online ? "" : "disabled"} aria-label="${esc(t("sendTextTo", { name }))}">${icon("i-text")}<span class="lbl">${esc(t("sendText"))}</span></button>
        </li>`,
      };
    }),
  );
}

type Row = { key: string; at: number; dir: "sent" | "received"; html: string };

function fileStatus(tr: TransferView, f: TransferView["files"][number], sent: boolean): string {
  if (tr.state === "offered") return "waiting";
  if (tr.state === "declined" || tr.state === "cancelled" || tr.state === "expired") return tr.state;
  if (f.state === "ready") return "done";
  if (f.state === "failed") return "failed";
  if (f.state === "uploading") return sent ? "sending" : "receiving";
  return "queued";
}

function renderTransfers(): void {
  const rows: Row[] = [];
  for (const tr of state.transfers.values()) {
    const sent = tr.from === ident.id;
    if (!sent && tr.state === "offered") continue; // shown as the incoming card
    const other = sent ? tr.to : tr.from;
    for (const f of tr.files) {
      const status = fileStatus(tr, f, sent);
      const key = `${tr.id}:${f.idx}`;
      let progress = "";
      if (status === "sending" || status === "receiving") {
        const bytes = sent ? (state.sent.get(key) ?? 0) : f.received;
        const r = track(key, bytes);
        const pct = f.size ? Math.min(100, Math.floor((bytes / f.size) * 100)) : 100;
        const eta = r.rate > 0 ? `<span>${esc(t("secsLeft", { eta: formatEta((f.size - bytes) / r.rate, lang) }))}</span>` : "";
        progress = `<div class="tr-progress"><div class="bar"><span class="track"><span class="fill${sent ? "" : " in"}" style="width:${pct}%"></span></span><span class="val">${pct}%</span></div>
          <p class="speed"><span>${r.rate > 0 ? esc(t("perSecond", { speed: formatBytes(Math.round(r.rate)) })) : ""}</span>${eta}</p></div>`;
      }
      const note =
        status === "waiting" ? `<p class="tr-note">${esc(t("waitingFor"))}</p>` : status === "failed" && tr.error ? `<p class="tr-note">${esc(errorText(tr.error))}</p>` : "";
      const canRetry = status === "failed" && sent && !!state.local.get(tr.id)?.[f.idx];
      const acts = [
        status === "done" && !sent && f.url ? `<a class="btn btn-secondary btn-sm" href="${esc(f.url)}" download="${esc(f.name)}">${icon("i-save")}<span class="lbl">${esc(t("save"))}</span></a>` : "",
        canRetry ? `<button class="btn btn-secondary btn-sm" type="button" data-act="retry" data-tid="${tr.id}" data-idx="${f.idx}">${icon("i-retry")}<span>${esc(t("retry"))}</span></button>` : "",
        sent && (tr.state === "offered" || tr.state === "accepted") && f.idx === 0 ? `<button class="btn btn-ghost btn-sm btn-icon" type="button" data-act="cancel" data-tid="${tr.id}" aria-label="${esc(t("cancelTransfer"))}" title="${esc(t("cancelTransfer"))}">${icon("i-x")}</button>` : "",
      ].join("");
      const dot = status === "waiting" || status === "queued" ? " wait" : status === "done" || status === "sending" || status === "receiving" ? "" : " bad";
      rows.push({
        key,
        at: tr.createdAt - f.idx / 1000,
        dir: sent ? "sent" : "received",
        html: `<li class="tr" data-dir="${sent ? "sent" : "received"}">
          <span class="tr-dir">${icon(sent ? "i-up" : "i-down")}</span>
          <div class="tr-body">
            <p class="tr-name">${esc(f.name)}</p>
            <dl class="tr-meta"><div><dt class="vh">${esc(t("size"))}</dt><dd>${formatBytes(f.size)}</dd></div><div><dt>${esc(t(sent ? "to" : "from"))}</dt><dd>${esc(peerName(other))}</dd></div></dl>
            ${note}${progress}
          </div>
          <div class="tr-end"><span class="pill"><span class="dot${dot}"></span><span>${esc(t(`st_${status}` as Key))}</span></span>${acts}</div>
        </li>`,
      });
    }
  }
  for (const m of state.texts) {
    const sent = m.from === ident.id;
    const link = m.text.match(/https?:\/\/[^\s<>"'，。！？、）」]+/i)?.[0] ?? null;
    rows.push({
      key: `text:${m.id}`,
      at: m.at,
      dir: sent ? "sent" : "received",
      html: `<li class="tr" data-dir="${sent ? "sent" : "received"}">
        <span class="tr-dir">${icon(sent ? "i-up" : "i-down")}</span>
        <div class="tr-body">
          <p class="tr-name">${esc(t("textItem"))}</p>
          <dl class="tr-meta"><div><dt>${esc(t(sent ? "to" : "from"))}</dt><dd>${esc(peerName(sent ? m.to : m.from))}</dd></div></dl>
          <p class="tr-quote">${esc(m.text)}</p>
          <div class="tr-acts">
            <button class="btn btn-secondary btn-sm" type="button" data-copy-text="${esc(m.id)}">${icon("i-copy")}<span>${esc(t("copy"))}</span></button>
            ${link ? `<a class="btn btn-secondary btn-sm" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${icon("i-link")}<span>${esc(t("openLink"))}</span></a>` : ""}
          </div>
        </div>
        <div class="tr-end"><span class="pill"><span class="dot"></span><span>${esc(t("st_done"))}</span></span></div>
      </li>`,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  const shown = rows.filter((r) => state.filter === "all" || r.dir === state.filter);
  patch($("#trList"), shown);
  const empty = $("#trEmpty");
  empty.hidden = shown.length > 0;
  empty.textContent = t(rows.length === 0 ? "trEmpty" : "trEmptyFilter");
  for (const b of $$<HTMLButtonElement>("#trFilter button")) b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));
}

// ---------- interactions ----------

const filePick = $<HTMLInputElement>("#filePick");
let pickTarget: string | null = null;

$("#chooseBtn").addEventListener("click", () => {
  pickTarget = null;
  filePick.click();
});

filePick.addEventListener("change", () => {
  const files = [...(filePick.files ?? [])];
  filePick.value = "";
  if (files.length === 0) return;
  if (pickTarget) void sendFiles(pickTarget, files);
  else {
    state.pending = files;
    renderPick();
  }
  pickTarget = null;
});

$("#pickCancel").addEventListener("click", () => {
  state.pending = null;
  renderPick();
});

$("#grid").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  const tile = btn?.closest<HTMLElement>(".tile");
  if (!btn || !tile) return;
  const peer = tile.dataset.peer!;
  if (btn.dataset.act === "text") return openText(peer);
  if (state.pending) {
    const files = state.pending;
    state.pending = null;
    renderPick();
    void sendFiles(peer, files);
    return;
  }
  pickTarget = peer;
  filePick.click();
});

// Drag files onto a tile to send them there, anywhere else to pick a device.
let dragTile: HTMLElement | null = null;
document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  const tile = (e.target as HTMLElement).closest<HTMLElement>(".tile:not(.is-off)");
  if (tile !== dragTile) {
    dragTile?.classList.remove("is-drop");
    tile?.classList.add("is-drop");
    dragTile = tile;
  }
});
document.addEventListener("dragleave", (e) => {
  if (!(e as DragEvent).relatedTarget) {
    dragTile?.classList.remove("is-drop");
    dragTile = null;
  }
});
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  const tile = (e.target as HTMLElement).closest<HTMLElement>(".tile:not(.is-off)");
  dragTile?.classList.remove("is-drop");
  dragTile = null;
  if (tile) void sendFiles(tile.dataset.peer!, files);
  else if (state.view === "filled") {
    state.pending = files;
    renderPick();
  }
});

// Paste files (a screenshot) to pick a device for them.
document.addEventListener("paste", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea")) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length && state.view === "filled") {
    state.pending = files;
    renderPick();
  }
});

$("#incoming").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  const card = btn?.closest<HTMLElement>("[data-tid]");
  if (!btn || !card) return;
  client.respond(card.dataset.tid!, btn.dataset.act === "accept");
});

$("#transfers").addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const f = el.closest<HTMLButtonElement>("#trFilter button");
  if (f) {
    state.filter = f.dataset.filter as typeof state.filter;
    renderTransfers();
    return;
  }
  const copyBtn = el.closest<HTMLElement>("[data-copy-text]");
  if (copyBtn) {
    const m = state.texts.find((x) => x.id === copyBtn.dataset.copyText);
    if (m) void copy(m.text);
    return;
  }
  const btn = el.closest<HTMLButtonElement>("button[data-act]");
  if (!btn) return;
  const tid = btn.dataset.tid!;
  if (btn.dataset.act === "cancel") client.cancel(tid);
  if (btn.dataset.act === "retry") {
    const tr = state.transfers.get(tid);
    const idx = Number(btn.dataset.idx);
    const file = state.local.get(tid)?.[idx];
    if (!tr || !file) return;
    // A failed file goes again on its own; the server lets it restart.
    const key = `${tid}:${idx}`;
    state.rates.delete(key);
    const up = client.upload(tid, idx, file, (sent) => {
      state.sent.set(key, sent);
      track(key, sent);
      schedule();
    });
    up.done
      .then(() => {
        const cur = state.transfers.get(tid);
        if (cur) void pump(cur);
      })
      .catch((err) => toast(`${file.name}: ${errorText(err instanceof Error ? err.message : "network")}`));
  }
});

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (b) void copy(b.dataset.copy!);
});

// Text dialog.
const dlg = $<HTMLDialogElement>("#textDlg");
let textTo = "";
function openText(peer: string): void {
  textTo = peer;
  $("#dlgTitle").textContent = t("dlgTitle", { name: peerName(peer) });
  $<HTMLTextAreaElement>("#textBody").value = "";
  dlg.showModal();
}
$("#dlgCancel").addEventListener("click", () => dlg.close());
$("#textForm").addEventListener("submit", (e) => {
  const body = $<HTMLTextAreaElement>("#textBody").value;
  if (!body.trim()) {
    e.preventDefault();
    return;
  }
  if (!client.text(textTo, body)) toast(errorText("offline"));
});

// Rename.
$("#renameBtn").addEventListener("click", () => {
  const input = $<HTMLInputElement>("#renameInput");
  input.value = splitName(ident.name).name;
  $("#renameForm").hidden = false;
  $("#renameBtn").hidden = true;
  $("#meName").hidden = true;
  input.focus();
  input.select();
});
$("#renameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>("#renameInput").value.trim().replace(/·/g, "");
  if (v) {
    const { os } = splitName(ident.name);
    ident.name = os ? `${v.slice(0, 30)} · ${os}` : v.slice(0, 40);
    saveIdentity(ident, store);
    client.rename(ident.name);
    renderMe();
  }
  $("#renameForm").hidden = true;
  $("#renameBtn").hidden = false;
  $("#meName").hidden = false;
});
$("#renameInput").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Escape") {
    $("#renameForm").hidden = true;
    $("#renameBtn").hidden = false;
    $("#meName").hidden = false;
  }
});

$("#retryNow").addEventListener("click", () => client.wake());
$("#useHere").addEventListener("click", () => {
  state.view = "loading";
  client.connect();
});

// PIN.
function showPin(msg: "pinBody" | "pinWrong" | "pinLocked"): void {
  state.view = "pin";
  if (msg !== "pinBody") set("lan-drop.pin", "");
  $("#shell").hidden = true;
  $("#me").hidden = true;
  $("#pinscreen").hidden = false;
  const m = $("#pinMsg");
  m.dataset.i18n = msg;
  m.textContent = t(msg);
  const boxes = $$<HTMLInputElement>("#pinBoxes input");
  for (const b of boxes) b.value = "";
  boxes[0]?.focus();
}
$("#pinBoxes").addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  el.value = el.value.replace(/\D/g, "").slice(-1);
  if (el.value) (el.nextElementSibling as HTMLInputElement | null)?.focus();
});
$("#pinBoxes").addEventListener("keydown", (e) => {
  const el = e.target as HTMLInputElement;
  if ((e as KeyboardEvent).key === "Backspace" && !el.value) (el.previousElementSibling as HTMLInputElement | null)?.focus();
});
$("#pinBoxes").addEventListener("paste", (e) => {
  const digits = ((e as ClipboardEvent).clipboardData?.getData("text") ?? "").replace(/\D/g, "").slice(0, 4);
  if (!digits) return;
  e.preventDefault();
  $$<HTMLInputElement>("#pinBoxes input").forEach((b, i) => (b.value = digits[i] ?? ""));
});
$("#pinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const pin = $$<HTMLInputElement>("#pinBoxes input").map((b) => b.value).join("");
  if (pin.length !== 4) return;
  client.pin = pin;
  set("lan-drop.pin", pin);
  state.view = "loading";
  client.connect();
});

// Come back at once when the phone wakes or the network returns.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) client.wake();
});
window.addEventListener("online", () => client.wake());

// ---------- start ----------

applyStatic();
setView("loading");
renderMe();
for (const p of $$("[data-view-part]")) p.hidden = p.dataset.viewPart !== "loading";

(async () => {
  let pinRequired = false;
  try {
    const info = await (await fetch("api/info", { cache: "no-store" })).json();
    state.joinUrls = info.joinUrls ?? [];
    state.lanUrls = info.lanUrls ?? [];
    state.home = info.home !== false;
    pinRequired = !!info.pinRequired;
  } catch {}
  // Through the space's router the page's own address is the one to share when no LAN address is known.
  if (state.joinUrls.length === 0 && !/^(localhost|127\.)/.test(location.hostname)) state.joinUrls = [location.origin + "/"];
  renderJoin();
  const saved = get("lan-drop.pin");
  if (pinRequired && !saved) return showPin("pinBody");
  if (saved) client.pin = saved;
  client.connect();
})();
