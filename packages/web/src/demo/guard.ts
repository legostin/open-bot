// The visitor cannot type in the demo: a quiet layer over the composer takes the clicks and says the script writes,
// while the script still types into the field underneath.

export function guardComposer(note: string): void {
  const layer = document.createElement("div");
  layer.className = "demo-guard";
  layer.title = note;
  layer.innerHTML = `<span class="demo-guard-note"></span>`;
  layer.querySelector(".demo-guard-note")!.textContent = note;
  document.body.appendChild(layer);
  const frame = () => {
    const field = document.querySelector("textarea");
    const box = field?.closest("form") ?? field?.parentElement?.parentElement;
    if (box) {
      const r = box.getBoundingClientRect();
      Object.assign(layer.style, { display: "flex", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      layer.classList.toggle("is-typing", !!field?.value);
      if (field && field.placeholder !== note) field.placeholder = note;
    } else layer.style.display = "none";
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) layer.addEventListener(type, stop);
  // Keys never reach the field from the visitor: only the script's input events change it.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.isTrusted && (e.target as Element | null)?.tagName === "TEXTAREA") stop(e);
    },
    true,
  );
  document.addEventListener(
    "beforeinput",
    (e) => {
      if (e.isTrusted && (e.target as Element | null)?.tagName === "TEXTAREA") stop(e);
    },
    true,
  );
}
