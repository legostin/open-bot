// The kit's own words (blocks, the error screen), in the hub's language. English is the source and the fallback.
import { translator, type Catalog, type Locale, type Params } from "../../shared/src/i18n.ts";

export const catalog = {
  en: {
    "error.title": "This page didn't open",
    "error.fix": "Ask to fix it",
    "error.ask": "The page “{title}” shows an error: {message}. Please fix it.",
    "weather.feels": "feels like {temp}",
    "weather.wind": "wind {speed} m/s",
    "weather.failed": "No forecast right now",
    "weather.today": "Today",
    "weather.clear": "Clear",
    "weather.mostlyClear": "Mostly clear",
    "weather.partly": "Partly cloudy",
    "weather.overcast": "Overcast",
    "weather.fog": "Fog",
    "weather.drizzle": "Drizzle",
    "weather.rain": "Rain",
    "weather.freezing": "Freezing rain",
    "weather.snow": "Snow",
    "weather.showers": "Showers",
    "weather.snowShowers": "Snow showers",
    "weather.thunder": "Thunderstorm",
    "map.route": "{km} km · {min} min",
    "place.route": "Route",
    "place.site": "Website",
    "place.more": "Ask",
    "place.ask": "Tell me more about “{name}”",
    "video.watch": "Watch",
  },
  ru: {
    "error.title": "Страница не открылась",
    "error.fix": "Попросить исправить",
    "error.ask": "Страница «{title}» показывает ошибку: {message}. Исправь, пожалуйста.",
    "weather.feels": "ощущается как {temp}",
    "weather.wind": "ветер {speed} м/с",
    "weather.failed": "Прогноз сейчас недоступен",
    "weather.today": "Сегодня",
    "weather.clear": "Ясно",
    "weather.mostlyClear": "Малооблачно",
    "weather.partly": "Переменная облачность",
    "weather.overcast": "Пасмурно",
    "weather.fog": "Туман",
    "weather.drizzle": "Морось",
    "weather.rain": "Дождь",
    "weather.freezing": "Ледяной дождь",
    "weather.snow": "Снег",
    "weather.showers": "Ливень",
    "weather.snowShowers": "Снегопад",
    "weather.thunder": "Гроза",
    "map.route": "{km} км · {min} мин",
    "place.route": "Маршрут",
    "place.site": "Сайт",
    "place.more": "Спросить",
    "place.ask": "Расскажи подробнее про «{name}»",
    "video.watch": "Смотреть",
  },
} satisfies Catalog;

export type KitKey = keyof typeof catalog.en;

let current: Locale = "en";
let tr = translator(catalog, current);

export function setLocale(locale: Locale): void {
  current = locale;
  tr = translator(catalog, locale);
}

export function locale(): Locale {
  return current;
}

export function t(key: KitKey, params?: Params): string {
  return tr(key, params);
}
