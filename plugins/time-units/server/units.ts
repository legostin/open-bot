// Unit conversion for time_units: every unit is a factor to its dimension's base unit (temperature has offsets).

export type Dimension = "length" | "mass" | "volume" | "speed" | "area" | "data" | "temperature" | "pressure" | "energy" | "duration";

interface Unit {
  dim: Dimension;
  /** Base units per one of this unit. */
  factor: number;
  /** The unit's symbol in answers. */
  symbol: string;
}

const U = (dim: Dimension, factor: number, symbol: string, ...aliases: string[]): Array<[string, Unit]> =>
  [symbol, ...aliases].map((a) => [a.toLowerCase(), { dim, factor, symbol }]);

const GAL = 3.785411784;

const UNITS = new Map<string, Unit>([
  // length, base metre
  ...U("length", 0.001, "mm", "millimeter", "millimeters", "millimetre", "millimetres"),
  ...U("length", 0.01, "cm", "centimeter", "centimeters", "centimetre", "centimetres"),
  ...U("length", 1, "m", "meter", "meters", "metre", "metres"),
  ...U("length", 1000, "km", "kilometer", "kilometers", "kilometre", "kilometres"),
  ...U("length", 0.0254, "in", "inch", "inches", '"'),
  ...U("length", 0.3048, "ft", "foot", "feet", "'"),
  ...U("length", 0.9144, "yd", "yard", "yards"),
  ...U("length", 1609.344, "mi", "mile", "miles"),
  ...U("length", 1852, "nmi", "nautical mile", "nautical miles"),
  // mass, base kilogram
  ...U("mass", 1e-6, "mg", "milligram", "milligrams"),
  ...U("mass", 0.001, "g", "gram", "grams"),
  ...U("mass", 1, "kg", "kilogram", "kilograms", "kilo", "kilos"),
  ...U("mass", 1000, "t", "tonne", "tonnes", "metric ton"),
  ...U("mass", 0.028349523125, "oz", "ounce", "ounces"),
  ...U("mass", 0.45359237, "lb", "lbs", "pound", "pounds"),
  ...U("mass", 6.35029318, "st", "stone", "stones"),
  // volume, base litre
  ...U("volume", 0.001, "ml", "milliliter", "milliliters", "millilitre", "millilitres"),
  ...U("volume", 1, "l", "liter", "liters", "litre", "litres"),
  ...U("volume", 1000, "m3", "m³", "cubic meter", "cubic meters"),
  ...U("volume", GAL / 768, "tsp", "teaspoon", "teaspoons"),
  ...U("volume", GAL / 256, "tbsp", "tablespoon", "tablespoons"),
  ...U("volume", GAL / 128, "fl oz", "floz", "fluid ounce", "fluid ounces"),
  ...U("volume", GAL / 16, "cup", "cups"),
  ...U("volume", GAL / 8, "pt", "pint", "pints"),
  ...U("volume", GAL / 4, "qt", "quart", "quarts"),
  ...U("volume", GAL, "gal", "gallon", "gallons"),
  // speed, base metre per second
  ...U("speed", 1, "m/s", "mps", "meters per second"),
  ...U("speed", 1 / 3.6, "km/h", "kmh", "kph", "kilometers per hour"),
  ...U("speed", 0.44704, "mph", "miles per hour"),
  ...U("speed", 1852 / 3600, "kn", "knot", "knots"),
  // area, base square metre
  ...U("area", 1, "m2", "m²", "sq m", "square meter", "square meters"),
  ...U("area", 1e6, "km2", "km²", "sq km", "square kilometer", "square kilometers"),
  ...U("area", 1e4, "ha", "hectare", "hectares"),
  ...U("area", 4046.8564224, "acre", "acres"),
  ...U("area", 0.09290304, "ft2", "ft²", "sq ft", "square foot", "square feet"),
  ...U("area", 2589988.110336, "mi2", "mi²", "sq mi", "square mile", "square miles"),
  // data, base byte
  ...U("data", 1, "B", "byte", "bytes"),
  ...U("data", 1e3, "KB", "kilobyte", "kilobytes"),
  ...U("data", 1e6, "MB", "megabyte", "megabytes"),
  ...U("data", 1e9, "GB", "gigabyte", "gigabytes"),
  ...U("data", 1e12, "TB", "terabyte", "terabytes"),
  ...U("data", 1024, "KiB", "kibibyte"),
  ...U("data", 1024 ** 2, "MiB", "mebibyte"),
  ...U("data", 1024 ** 3, "GiB", "gibibyte"),
  ...U("data", 1024 ** 4, "TiB", "tebibyte"),
  // temperature: factor unused (see convert)
  ...U("temperature", 1, "°C", "c", "celsius", "degc"),
  ...U("temperature", 1, "°F", "f", "fahrenheit", "degf"),
  ...U("temperature", 1, "K", "kelvin", "kelvins"),
  // pressure, base pascal
  ...U("pressure", 1, "Pa", "pascal", "pascals"),
  ...U("pressure", 100, "hPa", "hectopascal", "hectopascals", "mbar", "millibar"),
  ...U("pressure", 1000, "kPa", "kilopascal", "kilopascals"),
  ...U("pressure", 1e5, "bar", "bars"),
  ...U("pressure", 101325, "atm", "atmosphere", "atmospheres"),
  ...U("pressure", 133.322387415, "mmHg", "mm hg", "torr"),
  ...U("pressure", 6894.757293168, "psi"),
  // energy, base joule
  ...U("energy", 1, "J", "joule", "joules"),
  ...U("energy", 1000, "kJ", "kilojoule", "kilojoules"),
  ...U("energy", 4.184, "cal", "calorie", "calories"),
  ...U("energy", 4184, "kcal", "kilocalorie", "kilocalories"),
  ...U("energy", 3600, "Wh", "watt hour", "watt hours"),
  ...U("energy", 3.6e6, "kWh", "kilowatt hour", "kilowatt hours"),
  // duration, base second
  ...U("duration", 1, "s", "sec", "second", "seconds"),
  ...U("duration", 60, "min", "minute", "minutes"),
  ...U("duration", 3600, "h", "hr", "hour", "hours"),
  ...U("duration", 86400, "day", "days", "d"),
  ...U("duration", 604800, "week", "weeks", "wk"),
]);

export function unitOf(name: string): Unit | undefined {
  const key = name.trim().replace(/\s+/g, " ");
  // Case matters only where it tells units apart (MB vs mb is the same here, but "m" and "M" are not used otherwise).
  return UNITS.get(key.toLowerCase()) ?? UNITS.get(key.toLowerCase().replace(/^deg(rees?)? /, "").replace(/^°/, ""));
}

function toKelvin(v: number, symbol: string): number {
  return symbol === "°C" ? v + 273.15 : symbol === "°F" ? ((v - 32) * 5) / 9 + 273.15 : v;
}

function fromKelvin(k: number, symbol: string): number {
  return symbol === "°C" ? k - 273.15 : symbol === "°F" ? ((k - 273.15) * 9) / 5 + 32 : k;
}

/** `value` in `from` → `to`, or why not. */
export function convert(value: number, from: string, to: string): { value: number; from: string; to: string } | { error: string } {
  const a = unitOf(from);
  const b = unitOf(to);
  if (!a) return { error: `Unknown unit "${from}".` };
  if (!b) return { error: `Unknown unit "${to}".` };
  if (a.dim !== b.dim) return { error: `Cannot convert ${a.dim} (${a.symbol}) to ${b.dim} (${b.symbol}).` };
  const out = a.dim === "temperature" ? fromKelvin(toKelvin(value, a.symbol), b.symbol) : (value * a.factor) / b.factor;
  return { value: Number(out.toPrecision(10)), from: a.symbol, to: b.symbol };
}
