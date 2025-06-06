require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const moment = require("moment");

// Initialize bot with your token
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Octopus Energy API configuration
const octopusConfig = {
	baseURL: "https://api.octopus.energy/v1",
	apiKey: process.env.OCTOPUS_API_KEY,
	mpan: process.env.OCTOPUS_MPAN,
	serialNumber: process.env.OCTOPUS_SERIAL_NUMBER,
};

// Helper function to format timestamp
const formatTimestamp = () => {
	return moment().utc().format("YYYY-MM-DD HH:mm:ss UTC");
};

// Helper function to format usage data
const formatUsageData = (usage, cost) => {
	return `Usage: ${usage.toFixed(2)} kWh\nCost: £${cost.toFixed(2)}`;
};

// Get Kraken token for GraphQL API
async function getKrakenToken() {
	console.log("🔑 Obtaining Kraken token...");
	try {
		const response = await axios.post(
			"https://api.octopus.energy/v1/graphql/",
			{
				query: `mutation {
					obtainKrakenToken(input: {APIKey:"${octopusConfig.apiKey}"}) {
						token
						refreshToken
						refreshExpiresIn
					}
				}`,
			},
			{
				headers: {
					"Content-Type": "application/json",
				},
			}
		);
		console.log("✅ Kraken token obtained successfully");
		return response.data.data.obtainKrakenToken.token;
	} catch (error) {
		console.error("❌ Error obtaining Kraken token:", error.message);
		throw error;
	}
}

// Get meter GUID
async function getMeterGuid(token) {
	console.log("🔍 Looking up meter GUID...");
	try {
		const response = await axios.post(
			"https://api.octopus.energy/v1/graphql/",
			{
				query: `query {
					account(accountNumber: "${process.env.OCTOPUS_ACCOUNT_NUMBER}") {
						electricityAgreements(active: true) {
							meterPoint {
								meters(includeInactive: false) {
									smartDevices {
										deviceId
									}
								}
							}
						}
					}
				}`,
			},
			{
				headers: {
					"Content-Type": "application/json",
					Authorization: `JWT ${token}`,
				},
			}
		);

		const agreements = response.data.data.account.electricityAgreements;
		if (!agreements || agreements.length === 0) {
			throw new Error("No active electricity agreements found");
		}

		const meters = agreements[0].meterPoint.meters;
		if (!meters || meters.length === 0) {
			throw new Error("No active meters found");
		}

		const smartDevices = meters[0].smartDevices;
		if (!smartDevices || smartDevices.length === 0) {
			throw new Error("No smart devices found");
		}

		console.log("✅ Meter GUID found successfully");
		return smartDevices[0].deviceId;
	} catch (error) {
		console.error("❌ Error getting meter GUID:", error.message);
		throw error;
	}
}

// Get current live usage
async function getLiveUsage() {
	console.log("📊 Fetching live usage data...");
	try {
		// First get the Kraken token
		const token = await getKrakenToken();

		// Then get the meter GUID
		const meterGuid = await getMeterGuid(token);

		// Finally get the live usage data
		const response = await axios.post(
			"https://api.octopus.energy/v1/graphql/",
			{
				query: `{
					smartMeterTelemetry(deviceId: "${meterGuid}") {
						readAt
						demand
						consumption
					}
				}`,
			},
			{
				headers: {
					"Content-Type": "application/json",
					Authorization: `JWT ${token}`,
				},
			}
		);

		if (
			!response.data.data.smartMeterTelemetry ||
			response.data.data.smartMeterTelemetry.length === 0
		) {
			throw new Error("No telemetry data available");
		}

		const telemetry = response.data.data.smartMeterTelemetry[0];

		// If demand is null, try to calculate it from consumption
		if (telemetry.demand === null) {
			console.log("⚠️ No demand data available, returning 0");
			return 0;
		}

		console.log(`✅ Live usage data received: ${telemetry.demand}W`);
		// Ensure we return a number
		return Number(telemetry.demand);
	} catch (error) {
		console.error("❌ Error fetching live usage:", error.message);
		// Return 0 instead of throwing to prevent the bot from crashing
		return 0;
	}
}

// Get tariff information (dynamic unit rate and standing charge)
async function getTariffInfo() {
	try {
		// Step 1: Get account info to find the current tariff code
		const accountRes = await axios.get(
			`${octopusConfig.baseURL}/accounts/${process.env.OCTOPUS_ACCOUNT_NUMBER}/`,
			{
				headers: {
					Authorization: `Basic ${Buffer.from(
						octopusConfig.apiKey + ":"
					).toString("base64")}`,
				},
			}
		);
		const properties = accountRes.data.properties;
		const propertyWithMpan = properties.find((p) =>
			p.electricity_meter_points.some((e) => e.mpan === octopusConfig.mpan)
		);
		if (!propertyWithMpan) {
			throw new Error(`MPAN ${octopusConfig.mpan} not found in any property`);
		}
		const electricityPoints = propertyWithMpan.electricity_meter_points;
		const mpanPoint = electricityPoints.find(
			(e) => e.mpan === octopusConfig.mpan
		);
		const currentAgreement = mpanPoint.agreements.reduce((latest, current) => {
			if (!latest || new Date(current.valid_to) > new Date(latest.valid_to)) {
				return current;
			}
			return latest;
		}, null);
		const tariffCode = currentAgreement.tariff_code; // e.g. E-1R-VAR-22-11-01-A

		// Step 2: Parse product code and region letter from tariff code
		// Format: E-1R-<PRODUCT>-<REGION>
		const tariffParts = tariffCode.split("-");
		const productCode = tariffParts.slice(2, -1).join("-");
		const regionLetter = tariffParts[tariffParts.length - 1];

		// Step 3: Fetch product tariffs
		const productRes = await axios.get(
			`${octopusConfig.baseURL}/products/${productCode}/`
		);
		const tariffs = productRes.data.single_register_electricity_tariffs;
		const regionTariff = tariffs[`_${regionLetter}`];
		// Assume direct_debit_monthly for most users
		const details = regionTariff.direct_debit_monthly;

		return {
			name: productRes.data.display_name,
			unit_rate: (details.standard_unit_rate_inc_vat / 100).toFixed(4), // convert p/kWh to £/kWh
			standing_charge: (details.standing_charge_inc_vat / 100).toFixed(2), // convert p/day to £/day
		};
	} catch (error) {
		console.error("Error fetching tariff info:", error.message);
		throw error;
	}
}

// Get yesterday's usage
async function getYesterdayUsage() {
	const yesterday = moment().subtract(1, "days").format("YYYY-MM-DD");
	try {
		const response = await axios.get(
			`${octopusConfig.baseURL}/electricity-meter-points/${octopusConfig.mpan}/meters/${octopusConfig.serialNumber}/consumption/`,
			{
				headers: {
					Authorization: `Basic ${Buffer.from(
						octopusConfig.apiKey + ":"
					).toString("base64")}`,
				},
				params: {
					period_from: yesterday + "T00:00:00Z",
					period_to: yesterday + "T23:59:59Z",
					page_size: 48,
				},
			}
		);
		const tariff = await getTariffInfo();
		const totalUsage = response.data.results.reduce(
			(sum, reading) => sum + reading.consumption,
			0
		);
		const totalCost = totalUsage * parseFloat(tariff.unit_rate);
		return { usage: totalUsage, cost: totalCost };
	} catch (error) {
		console.error("Error fetching yesterday usage:", error.message);
		throw error;
	}
}

// Get monthly usage
async function getMonthlyUsage() {
	const thirtyDaysAgo = moment().subtract(30, "days").format("YYYY-MM-DD");
	try {
		const response = await axios.get(
			`${octopusConfig.baseURL}/electricity-meter-points/${octopusConfig.mpan}/meters/${octopusConfig.serialNumber}/consumption/`,
			{
				headers: {
					Authorization: `Basic ${Buffer.from(
						octopusConfig.apiKey + ":"
					).toString("base64")}`,
				},
				params: {
					period_from: thirtyDaysAgo + "T00:00:00Z",
					period_to: moment().format("YYYY-MM-DD") + "T23:59:59Z",
					page_size: 1000,
				},
			}
		);
		const tariff = await getTariffInfo();
		const totalUsage = response.data.results.reduce(
			(sum, reading) => sum + reading.consumption,
			0
		);
		const totalCost = totalUsage * parseFloat(tariff.unit_rate);
		return { usage: totalUsage, cost: totalCost };
	} catch (error) {
		console.error("Error fetching monthly usage:", error.message);
		throw error;
	}
}

// Generate status message
async function generateStatusMessage() {
	try {
		const liveUsage = await getLiveUsage();
		const yesterday = await getYesterdayUsage();
		const monthly = await getMonthlyUsage();
		const tariff = await getTariffInfo();

		return (
			`🔌 *Octopus Energy Status*\n\n` +
			`*Current Usage:* ${liveUsage.toFixed(0)}W\n\n` +
			`*Yesterday's Usage:*\n${formatUsageData(
				yesterday.usage,
				yesterday.cost
			)}\n\n` +
			`*Last 30 Days:*\n${formatUsageData(monthly.usage, monthly.cost)}\n\n` +
			`*Tariff Information:*\n` +
			`Name: ${tariff.name}\n` +
			`Unit Rate: £${tariff.unit_rate}/kWh\n` +
			`Standing Charge: £${tariff.standing_charge}/day\n\n` +
			`Last Updated: ${formatTimestamp()}`
		);
	} catch (error) {
		console.error("Error generating status message:", error.message);
		return "❌ Error fetching data. Please try again later.";
	}
}

// Handle /start command
bot.onText(/\/start/, async (msg) => {
	const chatId = msg.chat.id;
	console.log(`Received /start command from chat ${chatId}`);

	const keyboard = {
		inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "refresh" }]],
	};

	const message = await generateStatusMessage();
	bot.sendMessage(chatId, message, {
		parse_mode: "Markdown",
		reply_markup: keyboard,
	});
});

// Handle refresh button
bot.on("callback_query", async (callbackQuery) => {
	const chatId = callbackQuery.message.chat.id;
	const messageId = callbackQuery.message.message_id;

	if (callbackQuery.data === "refresh") {
		console.log(`Received refresh request from chat ${chatId}`);

		const keyboard = {
			inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "refresh" }]],
		};

		const message = await generateStatusMessage();
		bot.editMessageText(message, {
			chat_id: chatId,
			message_id: messageId,
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	}
});

async function getLiveUsageGraphQL() {
	try {
		const response = await axios.post(
			"https://api.octopus.energy/v1/graphql/",
			{
				query: `
					query {
						electricityConsumption(mpan: "${octopusConfig.mpan}", serialNumber: "${octopusConfig.serialNumber}") {
							liveUsage
							timestamp
						}
					}
				`,
			},
			{
				headers: {
					Authorization: `Basic ${Buffer.from(
						octopusConfig.apiKey + ":"
					).toString("base64")}`,
				},
			}
		);
		return response.data.data.electricityConsumption.liveUsage;
	} catch (error) {
		console.error("Error fetching live usage via GraphQL:", error.message);
		throw error;
	}
}

console.log("Bot started.");
