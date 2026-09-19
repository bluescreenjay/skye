export const WEATHER_FALLBACK = "hard to tell";

export function weatherPhrase(code: number, temp: number): string {
  const rounded = Math.round(temp);
  if (code === 0) return `clear, ${rounded}°`;
  if (code <= 2) return `mostly clear, ${rounded}°`;
  if (code === 3) return `overcast, ${rounded}°`;
  if (code <= 48) return `foggy, ${rounded}°`;
  if (code <= 57) return `drizzling, ${rounded}°`;
  if (code <= 67) return `rainy, ${rounded}°`;
  if (code <= 77) return `snowy, ${rounded}°`;
  if (code <= 82) return `showers, ${rounded}°`;
  if (code <= 99) return `stormy, ${rounded}°`;
  return `${rounded}°`;
}

function coords(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      () => reject(new Error("geolocation denied")),
      { timeout: 4000, maximumAge: 300000 },
    );
  });
}

export async function loadWeatherPhrase(): Promise<string> {
  try {
    const { latitude, longitude } = await coords();
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
    const response = await fetch(url);
    if (!response.ok) return WEATHER_FALLBACK;
    const data = (await response.json()) as {
      current?: { weather_code?: number; temperature_2m?: number };
    };
    const code = data.current?.weather_code;
    const temp = data.current?.temperature_2m;
    if (typeof code !== "number" || typeof temp !== "number") return WEATHER_FALLBACK;
    return weatherPhrase(code, temp);
  } catch {
    return WEATHER_FALLBACK;
  }
}
