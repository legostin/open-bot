// The app window's still picture: what shows until the live demo is up (and in place of it where it cannot run). Drawn
// in the app's own colours, so the swap to the real app is a quiet one.

const TEAM = [
  ["#4fd8c4", "#0e9384"],
  ["#ff8fc8", "#db2777"],
  ["#c08bff", "#7c3aed"],
  ["#6aa8ff", "#2563eb"],
];

function Candy({ colors, size = 26 }: { colors: string[]; size?: number }) {
  return (
    <span className="relative inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: `linear-gradient(${colors[0]}, ${colors[1]})` }}>
      <span className="absolute rounded-full bg-white" style={{ width: size * 0.22, height: size * 0.22, left: size * 0.24, top: size * 0.36 }} />
      <span className="absolute rounded-full bg-white" style={{ width: size * 0.22, height: size * 0.22, right: size * 0.24, top: size * 0.36 }} />
    </span>
  );
}

export function Poster() {
  return (
    <div className="absolute inset-0 flex bg-canvas" aria-hidden="true">
      <div className="hidden w-[27%] min-w-[180px] flex-col gap-2 p-3 @[600px]:flex">
        <div className="mb-2 h-5 w-24 rounded-md bg-surface-3/70" />
        {TEAM.map((c, i) => (
          <div key={i} className={`flex items-center gap-2.5 rounded-xl p-2 ${i === 1 ? "bg-surface shadow-[var(--shadow)]" : ""}`}>
            <Candy colors={c} />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="h-2.5 w-14 rounded bg-surface-3" />
              <div className="h-2 w-[80%] rounded bg-surface-3/60" />
            </div>
          </div>
        ))}
      </div>
      <div className="m-0 flex flex-1 flex-col bg-bg @[600px]:mt-2 @[600px]:rounded-tl-2xl">
        <div className="flex items-center gap-2 px-5 py-3">
          <Candy colors={TEAM[0]} size={22} />
          <div className="h-3 w-16 rounded bg-surface-3" />
        </div>
        <div className="flex flex-1 flex-col gap-4 px-5 py-3">
          <div className="flex gap-2.5">
            <Candy colors={TEAM[0]} />
            <div className="shimmer h-16 w-[62%] rounded-2xl" />
          </div>
          <div className="ml-auto h-9 w-[44%] rounded-2xl rounded-br-md bg-[#ffc43d]/80" />
          <div className="flex gap-2.5">
            <Candy colors={TEAM[0]} />
            <div className="flex w-[70%] flex-col gap-2">
              <div className="shimmer h-24 rounded-2xl" />
              <div className="flex gap-2">
                <div className="h-7 w-24 rounded-full bg-[#ffc43d]/70" />
                <div className="h-7 w-16 rounded-full bg-surface-2" />
              </div>
            </div>
          </div>
        </div>
        <div className="mx-4 mb-4 h-11 rounded-2xl bg-surface shadow-[0_0_0_1px_var(--border)]" />
      </div>
    </div>
  );
}
