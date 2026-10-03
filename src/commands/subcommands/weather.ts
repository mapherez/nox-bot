import Logger from "../../utils/logger.js";
import axios from 'axios';
import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';

async function weather(interaction: ChatInputCommandInteraction, location: string): Promise<void> {
  const apiKey = process.env.OPENWEATHER_API_KEY;

  if (!apiKey || apiKey === 'your_openweather_api_key_here') {
    await interaction.reply({
      content: '❌ Weather API key not configured. Please set up your OpenWeatherMap API key in the .env file.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const defaultLocation = location || 'London'; // Default to London if no location provided

  try {
    // First, get coordinates for the location (geocoding)
    const geoUrl = `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(defaultLocation)}&limit=1&appid=${apiKey}`;

    const geoResponse = await axios.get(geoUrl);
    const geoData = geoResponse.data;

    if (!geoData || geoData.length === 0) {
      await interaction.reply({
        content: `❌ Could not find location: ${defaultLocation}. Please try a different city name.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const { lat, lon, name, country } = geoData[0];

    // Use Current Weather API (free tier)
    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;

    const weatherResponse = await axios.get(weatherUrl);
    const weatherData = weatherResponse.data;

    // Extract weather data from Current Weather API response
    const temperature = Math.round(weatherData.main.temp);
    const feelsLike = Math.round(weatherData.main.feels_like);
    const humidity = weatherData.main.humidity;
    const windSpeed = Math.round((weatherData.wind?.speed || 0) * 3.6); // Convert m/s to km/h
    const description = weatherData.weather[0].description;
    const icon = weatherData.weather[0].icon;

    // Additional data available in Current Weather API
    const pressure = weatherData.main.pressure;
    const visibility = weatherData.visibility ? Math.round(weatherData.visibility / 1000) : null; // Convert to km

    // Get weather emoji based on icon
    const getWeatherEmoji = (iconCode: string): string => {
      const iconMap: Record<string, string> = {
        '01d': '☀️', '01n': '🌙', '02d': '⛅', '02n': '☁️',
        '03d': '☁️', '03n': '☁️', '04d': '☁️', '04n': '☁️',
        '09d': '🌧️', '09n': '🌧️', '10d': '🌦️', '10n': '🌧️',
        '11d': '⛈️', '11n': '⛈️', '13d': '❄️', '13n': '❄️',
        '50d': '🌫️', '50n': '🌫️'
      };
      return iconMap[iconCode] || '🌤️';
    };

    const weatherEmoji = getWeatherEmoji(icon);

    const weatherEmbed = {
      color: 0x0099ff,
      title: `${weatherEmoji} Weather for ${name}, ${country}`,
      fields: [
        {
          name: '🌡️ Temperature',
          value: `${temperature}°C (feels like ${feelsLike}°C)`,
          inline: true
        },
        {
          name: '💧 Humidity',
          value: `${humidity}%`,
          inline: true
        },
        {
          name: '💨 Wind Speed',
          value: `${windSpeed} km/h`,
          inline: true
        },
        {
          name: '🌤️ Conditions',
          value: description.charAt(0).toUpperCase() + description.slice(1),
          inline: false
        }
      ],
      footer: {
        text: 'Weather data provided by OpenWeatherMap'
      },
      timestamp: new Date().toISOString()
    };

    // Add additional fields if available
    if (pressure) {
      weatherEmbed.fields.push({
        name: '📊 Pressure',
        value: `${pressure} hPa`,
        inline: true
      });
    }

    if (visibility) {
      weatherEmbed.fields.push({
        name: '👁️ Visibility',
        value: `${visibility} km`,
        inline: true
      });
    }

    await interaction.reply({ embeds: [weatherEmbed] });

  } catch (error) {
    Logger.error('Weather API error:', (error as any).response?.data || (error as Error).message);

    let errorMessage = '❌ Sorry, I couldn\'t fetch the weather data right now.';

    if ((error as any).response?.status === 401) {
      errorMessage = '❌ Invalid API key. Please check your OpenWeatherMap API key and ensure your account is activated.';
    } else if ((error as any).response?.status === 429) {
      errorMessage = '❌ API rate limit exceeded. Please try again later.';
    } else if ((error as any).response?.status === 404) {
      errorMessage = '❌ Weather data not available for this location.';
    }

    await interaction.reply({
      content: errorMessage,
      flags: MessageFlags.Ephemeral
    });
  }
}

export { weather };