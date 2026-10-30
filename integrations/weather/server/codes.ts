// WMO weather codes (as Open-Meteo reports them) → a condition: its words for the model and its symbol for the card.
// Shared by the server (text for the model) and the UI module (the card; the words people read are in the locales).

export type Condition =
  | "clear"
  | "mostly-clear"
  | "partly-cloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "freezing-drizzle"
  | "light-rain"
  | "rain"
  | "heavy-rain"
  | "freezing-rain"
  | "light-snow"
  | "snow"
  | "heavy-snow"
  | "snow-grains"
  | "showers"
  | "heavy-showers"
  | "snow-showers"
  | "thunderstorm"
  | "thunderstorm-hail";

const BY_CODE: Record<number, Condition> = {
  0: "clear",
  1: "mostly-clear",
  2: "partly-cloudy",
  3: "overcast",
  45: "fog",
  48: "fog",
  51: "drizzle",
  53: "drizzle",
  55: "drizzle",
  56: "freezing-drizzle",
  57: "freezing-drizzle",
  61: "light-rain",
  63: "rain",
  65: "heavy-rain",
  66: "freezing-rain",
  67: "freezing-rain",
  71: "light-snow",
  73: "snow",
  75: "heavy-snow",
  77: "snow-grains",
  80: "showers",
  81: "showers",
  82: "heavy-showers",
  85: "snow-showers",
  86: "snow-showers",
  95: "thunderstorm",
  96: "thunderstorm-hail",
  99: "thunderstorm-hail",
};

export function conditionOf(code: number): Condition {
  return BY_CODE[code] ?? (code >= 95 ? "thunderstorm" : code >= 71 ? "snow" : code >= 51 ? "rain" : "overcast");
}

/** English words for the model. */
export const CONDITION_TEXT: Record<Condition, string> = {
  clear: "clear sky",
  "mostly-clear": "mostly clear",
  "partly-cloudy": "partly cloudy",
  overcast: "overcast",
  fog: "fog",
  drizzle: "drizzle",
  "freezing-drizzle": "freezing drizzle",
  "light-rain": "light rain",
  rain: "rain",
  "heavy-rain": "heavy rain",
  "freezing-rain": "freezing rain",
  "light-snow": "light snow",
  snow: "snow",
  "heavy-snow": "heavy snow",
  "snow-grains": "snow grains",
  showers: "rain showers",
  "heavy-showers": "heavy rain showers",
  "snow-showers": "snow showers",
  thunderstorm: "thunderstorm",
  "thunderstorm-hail": "thunderstorm with hail",
};

/** The card's symbol; clear and few clouds look different at night. */
export function conditionEmoji(c: Condition, day = true): string {
  switch (c) {
    case "clear":
      return day ? "☀️" : "🌙";
    case "mostly-clear":
      return day ? "🌤️" : "🌙";
    case "partly-cloudy":
      return day ? "⛅" : "☁️";
    case "overcast":
      return "☁️";
    case "fog":
      return "🌫️";
    case "drizzle":
    case "light-rain":
      return "🌦️";
    case "rain":
    case "heavy-rain":
    case "showers":
    case "heavy-showers":
    case "freezing-rain":
    case "freezing-drizzle":
      return "🌧️";
    case "light-snow":
    case "snow":
    case "heavy-snow":
    case "snow-grains":
    case "snow-showers":
      return "🌨️";
    case "thunderstorm":
    case "thunderstorm-hail":
      return "⛈️";
  }
}
