# Octogram - Octopus Energy Telegram Bot

A simple Telegram bot to display your Octopus Energy usage and tariff information.

## Features

- Get current live usage (W)
- Get yesterday's usage (kWh, £)
- Get last 30 days usage (kWh, £)
- Get current tariff name, unit rate, and standing charge (all fetched dynamically)
- Inline button to refresh
- UTC timestamp for last update
- Verbose output in the console
- Configuration via `.env`

## Setup

1. **Clone the repository**
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Create a `.env` file** (see below)
4. **Run the bot**
   ```bash
   node bot.js
   ```

## .env Example

```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
OCTOPUS_API_KEY=your_octopus_api_key
OCTOPUS_MPAN=your_mpan_number
OCTOPUS_SERIAL_NUMBER=your_meter_serial_number
OCTOPUS_ACCOUNT_NUMBER=your_account_number
```

- Get your Telegram bot token from @BotFather
- Get your Octopus API key, MPAN, serial number, and account number from your Octopus Energy dashboard

## Usage

- Start a chat with your bot on Telegram and send `/start`
- Use the inline "🔄 Refresh" button to update the data
- All output is in UTC
- Verbose logs are printed to the console

## Notes

- The bot fetches the current tariff and rates dynamically from the Octopus API
- If you have multiple properties/meters, ensure you use the correct MPAN and serial number
- For any issues, check the console output for errors
