// The forecast for a place from Open-Meteo (no key): now, and the next days.
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Sun, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../lib/utils";
import { locale, t, type KitKey } from "../i18n";
import { useJson } from "../runtime";

export interface WeatherProps {
  lat: number;
  lon: number;
  /** Days ahead, 1–7 (default 5). */
  days?: number;
  /** A heading, e.g. the place's name. */
  title?: string;
  className?: string;
}

interface Forecast {
  current?: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
  daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max?: Array<number | null> };
}

/** WMO weather codes in a few kinds people say. */
export function weatherKind(code: number): { key: KitKey; icon: LucideIcon } {
  if (code === 0) return { key: "weather.clear", icon: Sun };
  if (code === 1) return { key: "weather.mostlyClear", icon: Sun };
  if (code === 2) return { key: "weather.partly", icon: CloudSun };
  if (code === 3) return { key: "weather.overcast", icon: Cloud };
  if (code === 45 || code === 48) return { key: "weather.fog", icon: CloudFog };
  if (code >= 51 && code <= 57) return { key: "weather.drizzle", icon: CloudDrizzle };
  if (code === 66 || code === 67) return { key: "weather.freezing", icon: CloudRain };
  if (code >= 61 && code <= 65) return { key: "weather.rain", icon: CloudRain };
  if (code >= 71 && code <= 77) return { key: "weather.snow", icon: CloudSnow };
  if (code >= 80 && code <= 82) return { key: "weather.showers", icon: CloudRain };
  if (code === 85 || code === 86) return { key: "weather.snowShowers", icon: CloudSnow };
  if (code >= 95) return { key: "weather.thunder", icon: CloudLightning };
  return { key: "weather.overcast", icon: Cloud };
}

const deg = (v: number) => `${Math.round(v)}°`;

export function useWeather(lat: number, lon: number, days = 5) {
  const n = Math.min(7, Math.max(1, Math.round(days)));
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&wind_speed_unit=ms" +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${n}`;
  return useJson<Forecast>(Number.isFinite(lat) && Number.isFinite(lon) ? url : null);
}

export function Weather({ lat, lon, days = 5, title, className }: WeatherProps) {
  const { data, error, loading } = useWeather(lat, lon, days);
  if (loading) return <Skeleton className={cn("h-40 w-full rounded-xl", className)} />;
  if (error || !data?.current) {
    return (
      <Card className={cn("py-4", className)}>
        <CardContent className="text-sm text-muted-foreground">{t("weather.failed")}</CardContent>
      </Card>
    );
  }
  const now = data.current;
  const kind = weatherKind(now.weather_code);
  const day = new Intl.DateTimeFormat(locale(), { weekday: "short" });
  const daily = data.daily;
  return (
    <Card className={cn("gap-4 py-5", className)}>
      <CardContent className="flex items-center gap-4">
        <kind.icon className="size-12 shrink-0 text-amber-500" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          {title && <div className="truncate text-sm text-muted-foreground">{title}</div>}
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight">{deg(now.temperature_2m)}</span>
            <span className="truncate text-sm font-medium">{t(kind.key)}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {t("weather.feels", { temp: deg(now.apparent_temperature) })} · {t("weather.wind", { speed: Math.round(now.wind_speed_10m) })}
          </div>
        </div>
      </CardContent>
      {daily && daily.time.length > 1 && (
        <CardContent>
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${daily.time.length}, minmax(0, 1fr))` }}>
            {daily.time.map((d, i) => {
              const k = weatherKind(daily.weather_code[i]);
              const rain = daily.precipitation_probability_max?.[i];
              return (
                <div key={d} className="flex flex-col items-center gap-1 rounded-lg py-2 text-center">
                  <span className="text-xs text-muted-foreground capitalize">{i === 0 ? t("weather.today") : day.format(new Date(`${d}T12:00`))}</span>
                  <k.icon className="size-5" strokeWidth={1.75} aria-label={t(k.key)} />
                  <span className="text-sm font-medium">{deg(daily.temperature_2m_max[i])}</span>
                  <span className="text-xs text-muted-foreground">{deg(daily.temperature_2m_min[i])}</span>
                  {rain ? <span className="text-[10px] text-sky-600 dark:text-sky-400">{rain}%</span> : null}
                </div>
              );
            })}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
