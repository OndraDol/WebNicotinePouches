const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const pad = (value) => String(value).padStart(2, '0');

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validationError(field, code) {
  return { field, code };
}

export function safeParseJson(raw, fallback, onError = () => {}) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    onError(error);
    return fallback;
  }
}

export function validateSettings(input, todayKey = localDateKey(new Date())) {
  if (!isPlainObject(input)) {
    return { ok: false, value: null, errors: [validationError('settings', 'invalid_object')] };
  }

  const errors = [];
  const currency = typeof input.currency === 'string' ? input.currency.trim() : '';
  const packPrice = Number(input.packPrice);
  const pouchesPerPack = Number(input.pouchesPerPack);
  const dailyLimit = Number(input.dailyLimit);
  const goal = input.goal === 'quit' ? 'quit' : input.goal === 'track' ? 'track' : '';
  const strategy = input.strategy;
  const targetDate = typeof input.targetDate === 'string' ? input.targetDate : '';

  if (currency.length < 1 || currency.length > 8) errors.push(validationError('currency', 'invalid_currency'));
  if (!Number.isFinite(packPrice) || packPrice <= 0) errors.push(validationError('packPrice', 'invalid_price'));
  if (!Number.isInteger(pouchesPerPack) || pouchesPerPack < 1 || pouchesPerPack > 1000) {
    errors.push(validationError('pouchesPerPack', 'invalid_pouch_count'));
  }
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0) errors.push(validationError('dailyLimit', 'invalid_daily_limit'));
  if (!goal) errors.push(validationError('goal', 'invalid_goal'));

  if (goal === 'quit') {
    if (!['smooth', 'weekly', 'cutoff'].includes(strategy)) {
      errors.push(validationError('strategy', 'invalid_strategy'));
    }
    if (!DATE_PATTERN.test(targetDate) || targetDate < todayKey) {
      errors.push(validationError('targetDate', 'invalid_target_date'));
    }
  }

  if (errors.length) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      ...input,
      currency,
      packPrice,
      pouchesPerPack,
      dailyLimit,
      goal,
      ...(goal === 'quit' ? { strategy, targetDate } : {})
    }
  };
}

function validateHistoryEntry(input, index, todayKey) {
  const prefix = `history[${index}]`;
  if (!isPlainObject(input)) {
    return { errors: [validationError(prefix, 'invalid_object')], value: null };
  }

  const errors = [];
  const id = typeof input.id === 'string' ? input.id : '';
  const brand = typeof input.brand === 'string' ? input.brand.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const mg = Number(input.mg);
  const date = new Date(input.date);
  const entryDateKey = localDateKey(date);

  if (!HISTORY_ID_PATTERN.test(id)) errors.push(validationError(`${prefix}.id`, 'invalid_id'));
  if (brand.length < 1 || brand.length > 120) errors.push(validationError(`${prefix}.brand`, 'invalid_brand'));
  if (name.length < 1 || name.length > 120) errors.push(validationError(`${prefix}.name`, 'invalid_name'));
  if (!Number.isFinite(mg) || mg < 0 || mg > 1000) errors.push(validationError(`${prefix}.mg`, 'invalid_strength'));
  if (!entryDateKey || entryDateKey > todayKey) errors.push(validationError(`${prefix}.date`, 'invalid_date'));

  if (errors.length) return { errors, value: null };
  return {
    errors: [],
    value: {
      ...input,
      id,
      brand,
      name,
      mg,
      date: date.toISOString(),
      localDate: entryDateKey
    }
  };
}

export function validateBackup(input, todayKey = localDateKey(new Date())) {
  if (!isPlainObject(input) || !Array.isArray(input.history)) {
    return { ok: false, value: null, errors: [validationError('backup', 'invalid_object')] };
  }

  const settingsResult = validateSettings(input.settings, todayKey);
  const historyResults = input.history.map((entry, index) => validateHistoryEntry(entry, index, todayKey));
  const errors = [
    ...settingsResult.errors.map((error) => ({ ...error, field: `settings.${error.field}` })),
    ...historyResults.flatMap((result) => result.errors)
  ];

  if (errors.length) return { ok: false, value: null, errors };
  return {
    ok: true,
    errors: [],
    value: {
      settings: settingsResult.value,
      history: historyResults.map((result) => result.value)
    }
  };
}

export function toLocalDateTimeInput(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '', time: '' };
  return {
    date: localDateKey(date),
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  };
}

function neutralizeSpreadsheetFormula(value) {
  const text = String(value ?? '');
  return /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function quoteCsv(value) {
  return `"${neutralizeSpreadsheetFormula(value).replaceAll('"', '""')}"`;
}

export function buildHistoryCsv(history = []) {
  const rows = ['Date,Time,Brand,Name,Mg'];
  for (const entry of history) {
    const date = new Date(entry.date);
    if (Number.isNaN(date.getTime())) continue;
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    rows.push([
      localDateKey(date),
      time,
      quoteCsv(entry.brand),
      quoteCsv(entry.name),
      Number.isFinite(Number(entry.mg)) ? Number(entry.mg) : ''
    ].join(','));
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function mergeHistories(localHistory = [], remoteHistory = []) {
  const remoteById = new Map(remoteHistory.map((entry) => [entry.id, entry]));
  const localOnly = localHistory.filter((entry) => !remoteById.has(entry.id));
  const mergedById = new Map(localHistory.map((entry) => [entry.id, entry]));
  for (const entry of remoteHistory) mergedById.set(entry.id, entry);
  const merged = [...mergedById.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
  return { merged, localOnly };
}

export function getHistoryOwnerMode(owner, uid) {
  if (!owner || owner === 'guest') return 'guest';
  return owner === uid ? 'current' : 'other';
}

export function selectBenchmark(dailyAverage, benchmarks, historyLength) {
  if (!historyLength || !Array.isArray(benchmarks) || !benchmarks.length) return null;
  return benchmarks.find((benchmark) => dailyAverage <= benchmark.max) || benchmarks[benchmarks.length - 1];
}

function countHistoryByLocalDate(history) {
  return history.reduce((counts, entry) => {
    const key = entry.localDate || localDateKey(entry.date);
    if (key) counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

export function evaluatePeriodAchievements({ createdAt, history = [], today = new Date(), getLimitForDate }) {
  const trackingStart = new Date(Number(createdAt));
  const currentDay = new Date(today);
  if (Number.isNaN(trackingStart.getTime()) || Number.isNaN(currentDay.getTime()) || typeof getLimitForDate !== 'function') {
    return { cleanWeekend: false, yesterdaySuccess: false };
  }

  currentDay.setHours(0, 0, 0, 0);
  const trackingStartKey = localDateKey(trackingStart);
  const days = countHistoryByLocalDate(history);

  const yesterday = new Date(currentDay);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);
  const yesterdaySuccess = trackingStartKey <= yesterdayKey
    && (days[yesterdayKey] || 0) <= getLimitForDate(new Date(yesterday));

  const completedSunday = new Date(currentDay);
  completedSunday.setDate(completedSunday.getDate() - 1);
  while (completedSunday.getDay() !== 0) completedSunday.setDate(completedSunday.getDate() - 1);
  const completedSaturday = new Date(completedSunday);
  completedSaturday.setDate(completedSaturday.getDate() - 1);
  const saturdayKey = localDateKey(completedSaturday);
  const sundayKey = localDateKey(completedSunday);
  const cleanWeekend = trackingStartKey <= saturdayKey
    && (days[saturdayKey] || 0) <= getLimitForDate(new Date(completedSaturday))
    && (days[sundayKey] || 0) <= getLimitForDate(new Date(completedSunday));

  return { cleanWeekend, yesterdaySuccess };
}
