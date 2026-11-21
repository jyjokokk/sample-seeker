export {}; // makes this file an ES module (no clashes with DOM globals like `status`)

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const queryInput = $<HTMLInputElement>("query");
const resultsList = $<HTMLUListElement>("results");
const statusBar = $("status");
const dawBar = $("daw");

function render(results: { path: string; name: string; score: number }[]) {
  resultsList.replaceChildren(
    ...results.map((r) => {
      const li = document.createElement("li");
      li.textContent = `${r.name}  (${r.score.toFixed(3)})`;
      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        e.preventDefault();
        window.sf.startDrag(r.path); // main process does the native drag
      });
      // TODO: preview playback on click
      return li;
    }),
  );
}

// TODO: debounce, filters, keyboard navigation…
queryInput.addEventListener("input", async () => {
  const q = queryInput.value.trim();
  render(q ? await window.sf.call("search", q) : []);
});

$("add-folder").addEventListener("click", async () => {
  const roots = await window.sf.addFolder();
  statusBar.textContent = `Folders: ${roots.join(", ")}`;
});

$("index").addEventListener("click", () => window.sf.call("index"));

window.sf.on("engine-status", (s) => (statusBar.textContent = `Engine: ${s.state}`));
window.sf.on("index-progress", (p) => (statusBar.textContent = `Indexing ${p.done}/${p.total}`));

// TODO: when the DAW selection changes and the search box is empty,
// show window.sf.call("similar", state.selection.path)
function showDaw(s: DawState) {
  dawBar.textContent = s.connected ? `Live: ${s.tempo ?? "?"} BPM · ${s.camelot ?? "no key"}` : "Live: not connected";
}
window.sf.on("daw-state", showDaw);
window.sf.getDawState().then(showDaw);
