// The demo's page: a Saturday walk, written on the pages kit the way an agent writes one (page_create). The words and
// places come from data.<locale>.json; scripts/build-demo-pages.mjs compiles it with the hub's own page compiler.

import { useState } from "react";
import { Clock, Footprints, MapPin, Sun, Wallet, Wind } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Gallery, Hero, Place, Stat, useData } from "@piomio/page";

interface Stop {
  time: string;
  name: string;
  walk?: string;
  image: string;
  description: string;
  why: string;
  address: string;
  hours: string;
  price: string;
  tags: string[];
}

interface Walk {
  eyebrow: string;
  title: string;
  subtitle: string;
  hero: string;
  stats: { distance: string; time: string; budget: string; weather: string };
  labels: { distance: string; time: string; budget: string; weather: string; route: string; places: string; forecast: string; photos: string; wind: string };
  forecast: Array<{ day: string; high: string; low: string; sky: string }>;
  wind: string;
  stops: Stop[];
  photos: Array<{ src: string; caption: string }>;
}

export default function Page() {
  const w = useData<Walk>();
  const [active, setActive] = useState(0);
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-8">
      <Hero eyebrow={w.eyebrow} title={w.title} subtitle={w.subtitle} image={w.hero} />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={<Footprints className="size-4" />} label={w.labels.distance} value={w.stats.distance} />
        <Stat icon={<Clock className="size-4" />} label={w.labels.time} value={w.stats.time} />
        <Stat icon={<Wallet className="size-4" />} label={w.labels.budget} value={w.stats.budget} />
        <Stat icon={<Sun className="size-4" />} label={w.labels.weather} value={w.stats.weather} />
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card className="py-0">
          <CardContent className="p-5">
            <h2 className="mb-4 text-lg font-semibold">{w.labels.route}</h2>
            <ol className="relative flex flex-col gap-1">
              {w.stops.map((s, i) => (
                <li key={s.name}>
                  <button
                    type="button"
                    onClick={() => setActive(i)}
                    className={`flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition ${active === i ? "bg-primary/10" : "hover:bg-muted"}`}
                  >
                    <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${active === i ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{s.name}</span>
                      <span className="block text-sm text-muted-foreground">{s.time}</span>
                    </span>
                  </button>
                  {s.walk && (
                    <div className="ml-5 flex items-center gap-2 border-l-2 border-dashed border-primary/40 py-1 pl-5 text-xs text-muted-foreground">
                      <Footprints className="size-3" />
                      {s.walk}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        <Place index={active + 1} {...w.stops[active]} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{w.labels.forecast}</h2>
        <div className="grid grid-cols-3 gap-3">
          {w.forecast.map((f) => (
            <Card key={f.day} className="py-0">
              <CardContent className="flex flex-col items-center gap-1 p-4 text-center">
                <span className="text-sm text-muted-foreground">{f.day}</span>
                <span className="text-3xl">{f.sky}</span>
                <span className="font-semibold">
                  {f.high} <span className="font-normal text-muted-foreground">/ {f.low}</span>
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Wind className="size-4" />
          {w.wind}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{w.labels.photos}</h2>
        <Gallery images={w.photos} />
      </section>

      <footer className="flex flex-wrap items-center gap-2 pb-6 text-sm text-muted-foreground">
        <MapPin className="size-4" />
        {w.stops.map((s) => (
          <Badge key={s.name} variant="secondary">
            {s.name}
          </Badge>
        ))}
      </footer>
    </main>
  );
}
