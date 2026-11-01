const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');
const https = require('https');
const { Boom } = require('@hapi/boom');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sendTelegramAlert(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text)}`;
    https.get(url, (res) => {
        console.log('✅ Телеграмға ескерту сәтті жіберілді!');
    }).on('error', (e) => {
        console.error('❌ Телеграмға жіберуде қате:', e);
    });
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Promise Rejection:', reason);
    sendTelegramAlert(`🔴 БОТ ҚАТЕСІ (UnhandledRejection):\n${String(reason).substring(0, 500)}`);
});

process.on('uncaughtException', (err) => {
    console.error('🔴 Uncaught Exception:', err);
    sendTelegramAlert(`🔴 БОТ CRASH БОЛДЫ (UncaughtException):\n${err.message}\n\nPM2 автоматты қайта іске қосады.`);
    setTimeout(() => process.exit(1), 3000);
});

const GROUP_ID = process.env.GROUP_ID;
if (!GROUP_ID) {
    console.error('❌ GROUP_ID .env файлында көрсетілмеген!');
    process.exit(1);
}
const TIMEZONE = 'Asia/Almaty';
const START_DATE = '2026-02-16';
const START_JUZ_1 = 21;
const START_JUZ_5 = 1;

let sock = null;

function toBaileysJid(jid) {
    if (!jid) return jid;
    if (jid.includes('@g.us')) return jid;
    let bJid = jid.replace('@c.us', '@s.whatsapp.net').replace('@lid', '@s.whatsapp.net');
    if (!bJid.includes('@')) {
        bJid = `${bJid}@s.whatsapp.net`;
    }
    return bJid;
}

function fromBaileysJid(jid) {
    if (!jid) return jid;
    if (jid.includes('@g.us')) return jid;
    const parts = jid.split('@');
    const number = parts[0].split(':')[0];
    return `${number}@c.us`;
}

const STATS_FILE = './stats.json';
let db = {
    khatymCount_1: 1,
    khatymCount_5: 1,
    history_1: {},
    history_5: {},
    late_1: {},
    pastMsgIds_1: {},
    users_1: [],
    users_5: [],
    strikes: {},
    regMsgId_1: null,
    regMsgId_5: null,
    today: {
        date: '',
        msgId_1: null,
        msgId_5: null,
        read_1: [],
        read_5: []
    },
    lid_map: {},
    lastDm: {}
};

const RAMADAN_DATE = '2027-02-07';

if (fs.existsSync(STATS_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        db = { ...db, ...loaded };
        if (!db.today) db.today = { date: '', msgId_1: null, msgId_5: null, read_1: [], read_5: [] };
        if (!db.users_1) db.users_1 = [];
        if (!db.users_5) db.users_5 = [];
        if (!db.strikes) db.strikes = {};
        if (!db.late_1) db.late_1 = {};
        if (!db.pastMsgIds_1) db.pastMsgIds_1 = {};
        if (!db.hasOwnProperty('regMsgId_1')) db.regMsgId_1 = null;
        if (!db.hasOwnProperty('regMsgId_5')) db.regMsgId_5 = null;
        if (!db.lid_map) db.lid_map = {};
        if (!db.lastDm) db.lastDm = {};
    } catch (err) {
        console.error("Файлды оқуда қате шықты, жаңасын құрудамыз.", err);
    }
}
function saveDb() {
    fs.writeFile(STATS_FILE, JSON.stringify(db, null, 2), (err) => {
        if (err) console.error("❌ Қате: Базаны сақтау мүмкін болмады:", err);
    });
}

async function safeSendWithMentions(targetJid, text, mentionUserIds) {
    try {
        const safeMentions = mentionUserIds.map(toBaileysJid);
        if (safeMentions.length > 0) {
            await sock.sendMessage(targetJid, { text: text, mentions: safeMentions });
        } else {
            console.log('📤 Mentions-сіз жіберілуде...');
            await sock.sendMessage(targetJid, { text: text });
        }
    } catch (e) {
        console.log(`⚠️ Қате safeSendWithMentions: ${e.message}`);
        await sock.sendMessage(targetJid, { text: text }).catch(() => { });
    }
}

let simulatedDate = null;
function cleanUserId(userId) {
    return fromBaileysJid(userId);
}

/**
 * ──────────────────────────────────────────────────────────
 * LID (Linked Device ID) → Реальный номер телефона маппинг.
 * ──────────────────────────────────────────────────────────
 * Когда пользователь ставит реакцию с WhatsApp Web / ПК,
 * Baileys может вернуть скрытый 15-значный LID вместо номера.
 * Эта функция резолвит LID через groupMetadata.
 */

// Кэш: lid -> { realJid, timestamp }
const lidCache = new Map();
const LID_CACHE_TTL = 5 * 60 * 1000; // 5 минут

/**
 * Определяет, является ли JID скрытым LID.
 * LID — это числовой ID длиной ≥15 цифр (обычно ровно 15),
 * может приходить как "123456789012345@lid", "123456789012345@s.whatsapp.net",
 * или просто числовая строка без суффикса.
 */
function isLidJid(jid) {
    if (!jid) return false;
    // Явный суффикс @lid
    if (jid.includes('@lid')) return true;
    // Извлекаем числовую часть (до @ и до :)
    const numPart = jid.split('@')[0].split(':')[0];
    // LID: ≥15 цифр, обычные номера: 10-13 цифр
    return /^\d{15,}$/.test(numPart);
}

/**
 * Резолвит rawJid в реальный номер телефона.
 * Использует встроенный Baileys API (signalRepository.lidMapping)
 * для чтения маппингов LID ↔ PN из локальных файлов auth_info_baileys/.
 *
 * @param {string} rawJid — входящий JID (может быть LID или обычный)
 * @param {string} groupId — ID группы (используется как fallback)
 * @returns {Promise<string>} — реальный JID или исходный, если не удалось резолвить
 */
async function resolveRealJid(rawJid, groupId) {
    if (!rawJid || !isLidJid(rawJid)) return rawJid;

    const lidNum = rawJid.split('@')[0].split(':')[0];

    // 1. Проверяем ручной маппинг (db.lid_map)
    if (db.lid_map && db.lid_map[lidNum]) {
        console.log(`🔗 LID табылды (db.lid_map): ${lidNum} -> ${db.lid_map[lidNum]}`);
        return db.lid_map[lidNum];
    }

    // 2. Проверяем временный кэш
    const cached = lidCache.get(lidNum);
    if (cached && (Date.now() - cached.timestamp < LID_CACHE_TTL)) {
        console.log(`🔗 LID кэштен табылды: ${lidNum} → ${cached.realJid}`);
        return cached.realJid;
    }

    // 3. Baileys встроенный API: getPNForLID (auth_info_baileys/ файлдарынан оқиды)
    try {
        const lidJid = `${lidNum}@lid`;
        console.log(`🔍 LID резолвинг: ${rawJid} — Baileys lidMapping API арқылы...`);
        const pnJid = await sock.signalRepository.lidMapping.getPNForLID(lidJid);
        if (pnJid) {
            console.log(`✅ LID резолвинг сәтті (Baileys API): ${rawJid} → ${pnJid}`);
            lidCache.set(lidNum, { realJid: pnJid, timestamp: Date.now() });
            return pnJid;
        }
        console.log(`⚠️ Baileys lidMapping API: ${lidJid} үшін маппинг табылмады.`);
    } catch (err) {
        console.error(`❌ Baileys lidMapping API қатесі (${rawJid}):`, err.message);
    }

    // 4. Fallback: groupMetadata (ескі әдіс, таймаутпен)
    try {
        console.log(`🔍 LID резолвинг fallback: ${rawJid} — groupMetadata сұрау жіберілуде...`);
        const metadata = await Promise.race([
            sock.groupMetadata(groupId),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout groupMetadata")), 5000))
        ]);

        for (const participant of metadata.participants) {
            const pLid = participant.lid;
            if (pLid) {
                const pLidNum = pLid.split('@')[0].split(':')[0];
                if (pLidNum === lidNum) {
                    const realJid = participant.id;
                    console.log(`✅ LID резолвинг сәтті (groupMetadata): ${rawJid} → ${realJid}`);
                    lidCache.set(lidNum, { realJid, timestamp: Date.now() });
                    return realJid;
                }
            }
        }
        console.log(`⚠️ LID ${lidNum} groupMetadata-дан да табылмады.`);
    } catch (err) {
        console.error(`❌ groupMetadata fallback қатесі (${rawJid}):`, err.message);
    }

    console.log(`⚠️ LID ${lidNum} ешбір әдіспен резолвингті мүмкін болмады. Исходный LID қайтарылады.`);
    return rawJid;
}

/**
 * Нормализует ID пользователя до чистого номера (без суффиксов).
 * Используется для «мягкого» сравнения ID из Baileys (@s.whatsapp.net)
 * с ID из базы (@c.us) — сравниваем только цифры.
 */
function normalizeId(id) {
    if (!id) return '';
    // Убираем device suffix (77001234567:123@s.whatsapp.net -> 77001234567)
    return id.split('@')[0].split(':')[0];
}

/**
 * Проверяет, содержится ли userId в массиве userList,
 * сравнивая только числовую часть ID (без @c.us / @s.whatsapp.net).
 */
function includesUser(userList, userId) {
    const normalizedTarget = normalizeId(userId);
    return userList.some(u => normalizeId(u) === normalizedTarget);
}

/**
 * Находит и возвращает ID из массива, совпадающий по числовой части.
 * Нужно чтобы push/splice работали с тем же форматом, что в массиве.
 */
function findMatchingId(userList, userId) {
    const normalizedTarget = normalizeId(userId);
    return userList.find(u => normalizeId(u) === normalizedTarget);
}

/**
 * Очищает эмодзи от модификаторов цвета кожи (Fitzpatrick scale)
 * и variation selectors, оставляя базовый символ.
 * 👍🏽 -> 👍, ❤️ -> ❤
 */
function stripEmojiModifiers(emoji) {
    if (!emoji) return emoji;
    // Remove skin tone modifiers (U+1F3FB..U+1F3FF) and variation selectors (U+FE0E, U+FE0F)
    return emoji.replace(/[\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F]/gu, '');
}

function getAlmatyDateStr() {
    if (simulatedDate) return simulatedDate;
    let d = new Date(new Date().toLocaleString("en-US", { timeZone: TIMEZONE }));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWorkingDaysCount(targetDateStr) {
    const start = new Date(START_DATE + 'T00:00:00');
    const target = new Date(targetDateStr + 'T00:00:00');
    if (target < start) return 0;
    let count = 0;
    let current = new Date(start);
    while (current < target) {
        if (current.getDay() !== 0) count++;
        current.setDate(current.getDate() + 1);
    }
    return count;
}

function getJuz1(count) {
    return ((START_JUZ_1 - 1 + count) % 30) + 1;
}

function getJuz5(count) {
    let start = ((START_JUZ_5 - 1 + count * 5) % 30) + 1;
    let end = start + 4;
    let pages = [];
    for (let i = 0; i < 5; i++) {
        let p = ((start - 1 + i) % 30) + 1;
        pages.push(p);
    }
    return { start: pages[0], end: pages[4], list: pages };
}

function getPagesForJuz(j) {
    if (j === 1) return { start: 1, end: 21 };
    let start = 22 + (j - 2) * 20;
    let end = (j === 30) ? 604 : start + 19;
    return { start, end };
}

function getWeekDates(currentDateStr) {
    let dates = [];
    let d = new Date(currentDateStr + 'T00:00:00');
    let day = d.getDay();
    let diff = d.getDate() - day + (day === 0 ? -6 : 1);
    let monday = new Date(d.setDate(diff));
    for (let i = 0; i < 6; i++) {
        let temp = new Date(monday);
        temp.setDate(monday.getDate() + i);
        dates.push(`${temp.getFullYear()}-${String(temp.getMonth() + 1).padStart(2, '0')}-${String(temp.getDate()).padStart(2, '0')}`);
    }
    return dates;
}

function getLastWorkingDates(endDateStr, totalDays) {
    let dates = [];
    let d = new Date(endDateStr + 'T00:00:00');
    while (dates.length < totalDays) {
        if (d.getDay() !== 0) {
            dates.unshift(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        }
        d.setDate(d.getDate() - 1);
    }
    return dates;
}

function formatDateToKazakh(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${day}.${month}.${year}`;
}


async function sendRegistrationMessages() {
    try {
        const msg1 = await sock.sendMessage(GROUP_ID, {
            text: `📢 *ХАТЫМҒА ТІРКЕЛУ*\n` +
                `───────────────\n` +
                `📘 *1-ПАРА ТОБЫ*\n\n` +
                `Күн сайын 1 парадан оқып, 30 күнде Хатым ету тобына қосылғыңыз келсе, осы хабарламаға 👍 (лайк) немесе ✅ басыңыз!\n\n` +
                `⚠️ *Маңызды:*\n` +
                `Тіркелу тек бүгін жүреді.`
        });
        db.regMsgId_1 = msg1.key.id;
        saveDb();
        console.log("Тіркелу хабарламалары жіберілді.");
    } catch (e) {
        console.error("Тіркелу жіберуде қате:", e);
    }
}

async function sendMorningTask(dateStr) {
    try {
        const count = getWorkingDaysCount(dateStr);
        const juz1 = getJuz1(count);
        const pStart1 = getPagesForJuz(juz1).start;
        const pEnd1 = getPagesForJuz(juz1).end;

        if (db.today && db.today.msgId_1 && db.today.date) {
            if (!db.pastMsgIds_1) db.pastMsgIds_1 = {};
            db.pastMsgIds_1[db.today.msgId_1] = db.today.date;
        }

        db.today = {
            date: dateStr,
            msgId_1: null,
            msgId_5: null,
            read_1: [],
            read_5: []
        };
        saveDb();

        const msg1 = await sock.sendMessage(GROUP_ID, {
            text: `🌅 *Ассаламу алейкум уа рахматуллаһи уа баракатуһ!*\n` +
                `📅 Күн: *${formatDateToKazakh(dateStr)}*\n` +
                `───────────────\n` +
                `📖 Бүгінгі бөлік: *${juz1}-пара*\n` +
                `📄 Беттер: ${pStart1} — ${pEnd1}\n\n` +
                `✅ Оқып біткен соң, осы хатқа реакция (👍 немесе ✅) қойыңыз!`
        });
        db.today.msgId_1 = msg1.key.id;
        saveDb();
        console.log(`Тапсырма ${dateStr} күніне жіберілді.`);

        if (juz1 === 30) await sock.sendMessage(GROUP_ID, { text: "🎉 Бүгін Хатымның соңғы күні! Жігерленіп, аяқтап тастайық!" });

        // ── Milestone celebrations ──
        // Хатымның жартысы (экватор)
        if (juz1 === 15) {
            await sock.sendMessage(GROUP_ID, {
                text: `🌗 *Жарты жолдан өттік!*\n` +
                    `15/30 пара оқылды! Жартысы артта қалды!\n` +
                    `Қалған 15 параны да бірге аяқтайық, ИншаАллаһ! 💪🤲`
            });
        }
        // Дөңгелек оқу күндері (50, 100, 150, 200...)
        if (count > 0 && count % 50 === 0) {
            await sock.sendMessage(GROUP_ID, {
                text: `🎉 *МЕРЕЙТОЙ!*\n` +
                    `Бүгін біздің *${count}-ші* оқу күніміз!\n` +
                    `Алла Тағала барлық оқыған Құранымызды қабыл етсін! 🤲\n` +
                    `Алға, тоқтамай жалғастырамыз! 🚀`
            });
        }
        // Хатм номерін атап өту (5, 10, 15...)
        if (juz1 === 1 && db.khatymCount_1 > 1 && (db.khatymCount_1 - 1) % 5 === 0) {
            await sock.sendMessage(GROUP_ID, {
                text: `🏆 *СубханАллаһ!*\n` +
                    `Бұл біздің *${db.khatymCount_1}-ші ХАТЫМЫМЫЗ* басталды!\n` +
                    `Алла барлық оқығанымызды қабыл етсін! 🤲`
            });
        }

    } catch (e) {
        console.error("Тапсырма жіберуде қате шықты:", e);
    }
}

async function sendWarning(hour, isSatSpecial = false) {
    if (!db.today.msgId_1) return;

    try {
        const validUsers1 = db.users_1.filter(u => u);
        const debtors1 = validUsers1.filter(u => !includesUser(db.today.read_1, u));
        const totalUsers = validUsers1.length;

        if (totalUsers === 0) return;

        if (debtors1.length === 0) {
            const dateStr = db.today.date || getAlmatyDateStr();
            db.history_1[dateStr] = [...db.today.read_1];

            await sock.sendMessage(GROUP_ID, {
                text: `✅ *МашаАллаһ!*\n` +
                    `Бүгін барлық қатысушылар тапсырманы ерте аяқтады!\n` +
                    `Дедлайн жабылды. Алла разы болсын! 🤲`
            });

            const count = getWorkingDaysCount(dateStr);
            const juz1 = getJuz1(count);
            if (juz1 === 30) await sendKhatmStats('GROUP_1', dateStr);

            const dObj = new Date(dateStr + 'T00:00:00');
            if (dObj.getDay() === 6) {
                await sendWeeklyStats(GROUP_ID, dateStr);
            }

            if (db.today.msgId_1) {
                if (!db.pastMsgIds_1) db.pastMsgIds_1 = {};
                db.pastMsgIds_1[db.today.msgId_1] = dateStr;
            }
            db.today.msgId_1 = null;
            saveDb();
            return;
        }

        // Хадистер мен мотивациялық сөздер ротациясы
        const reminderQuotes = [
            `📿 Аллаһ елшісі ﷺ : *«Кімде-кім Алланың кітабынан бір әріп оқыса, оған бір жақсылық (сауап) жазылады. Ал әрбір жақсылық он еселенеді. Мен „Әлиф, Ләм, Мимді“ бір әріп деп айтпаймын. Керісінше, „Әлиф“ — бір әріп, „Ләм“ — бір әріп, „Мим“ де — дербес бір әріп», — деген»*\n— (Имам Тирмизи)`,
            `📿 Аллаһ елшісі ﷺ : *«Құран оқыңдар, өйткені ол Қиямет күні оқыған адамына шапағатшы болады»*\n— (Муслим)`,
            `📿 Аллаһ елшісі ﷺ : *«Құранды шебер оқитын адам — ардақты періштелермен бірге болады»*\n— (Бухари, Муслим)`,
            `📿 Аллаһ елшісі ﷺ : *«Аллаһтың ең жақсы көретін ісі — аз болса да тұрақты істелетін іс»*\n— (Бухари, Муслим)`,
            `📿 Аллаһ елшісі ﷺ : *«Жүрегінде Құраны жоқ адам – қираған үй секілді»*\n— (Тирмизи)`,
            `📿 Аллаһ елшісі ﷺ : *«Ақиқатында, жүректер Алланы еске алумен тыныштық табады»*\n— (Ар-Рағд, 13:28)`,
            `📿 Аллаһ елшісі ﷺ : *\n«خَيْرُكُمْ مَنْ تَعَلَّمَ الْقُرْآنَ وَعَلَّمَهُ»\n«Сендердің ең жақсыларың (ең абзалдарың) — Құранды үйреніп, оны басқаларға үйреткендерің»*\n— (Бухари 5027)`
        ];
        const quoteIndex = Math.floor(Date.now() / 86400000) % reminderQuotes.length;
        const todayQuote = reminderQuotes[quoteIndex];

        const readCount = db.today.read_1.length;
        const readPercent = totalUsers > 0 ? Math.round((readCount / totalUsers) * 100) : 0;

        let text = "";
        if (isSatSpecial) {
            text = `🤲 *Кешкі еске салу*\n\n` +
                `${todayQuote}\n\n` +
                `📊 Бүгін: *${readCount}/${totalUsers}* оқып бітірді (${readPercent}%)\n` +
                `───────────────\n\n` +
                `Сенбілік параны оқуға Жексенбі кешке дейін уақыт бар!\n` +
                `Сіздерді күтіп отырмыз:\n\n`;
        } else {
            text = `🤲 *Кешкі еске салу*\n\n` +
                `${todayQuote}\n\n` +
                `📊 Бүгін: *${readCount}/${totalUsers}* оқып бітірді (${readPercent}%)\n` +
                `───────────────\n\n` +
                `Бүгінгі параны оқуға әлі уақыт бар!\n` +
                `Сіздерді күтіп отырмыз:\n\n`;
        }

        if (debtors1.length > 0) {
            for (let uid of debtors1) {
                text += `@${uid.split('@')[0]} `;
            }
            text += "\n\n";
            text += `💡 _Тіпті аздап оқысаңыз да — сауабы зор!_`;
            await safeSendWithMentions(GROUP_ID, text, debtors1);
        }
    } catch (e) {
        console.error("Ескерту жіберуде қате шықты:", e);
    }
}

async function sendDeadline(dateStr) {
    if (!db.today.msgId_1) return;

    try {
        const taskDate = db.today.date || dateStr;
        db.history_1[taskDate] = [...db.today.read_1];

        let text = `🛑 *ДЕДЛАЙН ЖАБЫЛДЫ*\n` +
            `📅 Күн: ${formatDateToKazakh(taskDate)}\n` +
            `───────────────\n\n`;

        const missed1 = db.users_1.filter(u => !includesUser(db.today.read_1, u));

        for (let uid of missed1) {
            if (!db.strikes) db.strikes = {};
            if (!db.strikes[uid]) db.strikes[uid] = 0;
            db.strikes[uid]++;
        }

        if (missed1.length > 0) {
            text += "Өкінішке орай, мына қатысушылар үлгермеді:\n";
            for (let uid of missed1) {
                text += `@${uid.split('@')[0]} `;
            }
            text += "\n";
            await safeSendWithMentions(GROUP_ID, text, missed1);
        } else {
            await sock.sendMessage(GROUP_ID, { text: "✅ *МашаАллаһ!* Бүгін барлық қатысушылар өз параларын толық оқып бітірді! Алла қабыл етсін!" });
        }

        const count = getWorkingDaysCount(taskDate);
        const juz1 = getJuz1(count);

        if (juz1 === 30) await sendKhatmStats('GROUP_1', taskDate);

        const dObj = new Date(taskDate + 'T00:00:00');
        if (dObj.getDay() === 6) {
            await sendWeeklyStats(GROUP_ID, taskDate);
        }

        if (db.today.msgId_1) {
            if (!db.pastMsgIds_1) db.pastMsgIds_1 = {};
            db.pastMsgIds_1[db.today.msgId_1] = taskDate;
        }
        db.today.msgId_1 = null;
        saveDb();

    } catch (e) {
        console.error("Дедлайн өңдеуде қате шықты:", e);
    }
}

/**
 * Персональные мягкие DM напоминания.
 * Отправляется не чаще 1 раза в неделю:
 * - участникам, пропустившим 2+ рабочих дня подряд;
 * - ИЛИ если вместе (пропущенные дни + закрытые с опозданием долги) > 3 дней.
 */
async function sendPersonalReminders() {
    try {
        const todayStr = getAlmatyDateStr();
        const todayDate = new Date(todayStr + 'T00:00:00');

        for (let uid of db.users_1) {
            // Проверяем: не отправляли ли DM за последние 7 дней
            if (db.lastDm[uid]) {
                const lastDmDate = new Date(db.lastDm[uid] + 'T00:00:00');
                const daysSinceLastDm = Math.floor((todayDate - lastDmDate) / 86400000);
                if (daysSinceLastDm < 7) continue;
            }

            // Проверяем последние 6 рабочих дней (рабочая неделя)
            let consecutiveMisses = 0;
            let countingConsecutive = true;
            let missedDays = 0;
            let lateDays = 0;

            let checkDate = new Date(todayStr + 'T00:00:00');
            let checkedWorkDays = 0;

            while (checkedWorkDays < 6) {
                checkDate.setDate(checkDate.getDate() - 1);
                if (checkDate.getDay() === 0) continue; // Жексенбі демалыс
                checkedWorkDays++;

                const dStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
                const reads = db.history_1[dStr] || [];
                const lateReads = db.late_1[dStr] || [];

                const isReadOnTime = includesUser(reads, uid);
                const isReadLate = includesUser(lateReads, uid);

                if (isReadOnTime) {
                    countingConsecutive = false;
                } else if (isReadLate) {
                    lateDays++;
                    countingConsecutive = false;
                } else {
                    missedDays++;
                    if (countingConsecutive) {
                        consecutiveMisses++;
                    }
                }
            }

            const totalIssueDays = missedDays + lateDays;

            // Шарт:
            // 1) Қатарынан 2+ күн оқымаған
            // 2) НЕМЕСЕ оқылмаған күндер мен кешігіп жабылған қарыздар бірге 3 күннен көп болса (> 3)
            const shouldSend = (totalIssueDays > 3);

            if (shouldSend) {
                const userJid = toBaileysJid(uid);
                try {
                    const messageText = `🤲 *Ассаламу алейкум!*\n\n` +
                        `💎 *Аллаһ сізге бір күнде 1440 алтын берді — соның 40-ын Оған қайта бере аласыз ба?*\n\n` +
                        `Бір пара оқу — бар болғаны *40 минут*.\n` +
                        `Ал оның сауабы — шексіз! 🤲\n\n` +
                        `💡 Қайтып оқысаңыз — қарызды ескі тапсырмаға *+* жауап жазып жаба аласыз.\n`;

                    await sock.sendMessage(userJid, { text: messageText });
                    db.lastDm[uid] = todayStr;
                    saveDb();
                    console.log(`📩 Персональды DM жіберілді: ${uid} (consecutiveMisses=${consecutiveMisses}, missedDays=${missedDays}, lateDays=${lateDays}, totalIssueDays=${totalIssueDays})`);
                } catch (dmErr) {
                    console.error(`❌ DM жіберу қатесі (${uid}):`, dmErr.message);
                }
            }
        }
    } catch (e) {
        console.error('Персональды еске салу қатесі:', e);
    }
}

/**
 * Рамазанға кері санақ.
 * Белгілі threshold-тарда (180, 150, 120, 90, 60, 45, 30, 21, 14, 7, 3, 2, 1)
 * топқа мотивациялық хабарлама жібереді.
 */
async function checkRamadanCountdown() {
    try {
        const todayStr = getAlmatyDateStr();
        const today = new Date(todayStr + 'T00:00:00');
        const ramadan = new Date(RAMADAN_DATE + 'T00:00:00');
        const daysLeft = Math.ceil((ramadan - today) / 86400000);

        if (daysLeft <= 0) return;

        const thresholds = [120, 90, 60, 45, 30, 21, 14];
        if (!thresholds.includes(daysLeft)) return;

        let emoji, urgency;
        if (daysLeft <= 45) {
            emoji = '🌙';
            urgency = 'Рамазанға дайындалу уақыты жақындады!';
        } else {
            emoji = '📅';
            urgency = 'Құран оқуды тоқтатпайық!';
        }

        const months = Math.floor(daysLeft / 30);
        const remainDays = daysLeft % 30;
        let timeText;
        if (months > 0 && remainDays > 0) {
            timeText = `*${months} ай ${remainDays} күн*`;
        } else if (months > 0) {
            timeText = `*${months} ай*`;
        } else {
            timeText = `*${daysLeft} күн*`;
        }

        await sock.sendMessage(GROUP_ID, {
            text: `${emoji} *РАМАЗАНҒА КЕРІ САНАҚ*\n` +
                `───────────────\n\n` +
                `Рамазанға ${timeText} қалды!\n\n` +
                `${urgency}\n\n` +
                `📖 Құранды үзбей оқып, Рамазанға дайын жүрекпен кірейік!`
        });
        console.log(`🌙 Рамазан кері санағы: ${daysLeft} күн қалды`);
    } catch (e) {
        console.error('Рамазан кері санақ қатесі:', e);
    }
}

async function sendWeeklyStats(targetJid, dateStr) {
    const weekDates = getWeekDates(dateStr);
    let text = `📊 *АПТАЛЫҚ ЕСЕП*\n` +
        `📅 ${formatDateToKazakh(weekDates[0])} — ${formatDateToKazakh(weekDates[weekDates.length - 1])}\n` +
        `───────────────\n\n`;

    const validUsers = db.users_1.filter(u => u);
    if (validUsers.length === 0) {
        text += `📘 *ОҚЫҒАНДАР ТІЗІМІ*\n_Әзірге қатысушылар жоқ_\n\n`;
    } else {
        let visualList = "";
        let best = [], good = [], weak = [];

        for (let uid of validUsers) {
            let marks = "";
            let presentCount = 0;
            let lateCount = 0;
            let userName = `@${uid.split('@')[0]}`;

            for (let d of weekDates) {
                let reads = (d === db.today.date) ? db.today.read_1 : (db.history_1[d] || []);
                if (includesUser(reads, uid)) { marks += "✅"; presentCount++; }
                else if (db.late_1[d] && includesUser(db.late_1[d], uid)) { marks += "🟧"; lateCount++; }
                else { marks += "❌"; }
            }
            const lateLabel = lateCount > 0 ? `+${lateCount}⏳` : '';
            visualList += `${userName}: ${marks} (${presentCount}${lateLabel}/6)\n`;

            const totalDone = presentCount + lateCount;
            if (totalDone === 6) best.push(userName);
            else if (totalDone >= 4) good.push(userName);
            else {
                weak.push({ name: userName, missed: 6 - totalDone });
            }
        }

        weak.sort((a, b) => b.missed - a.missed);
        let weakText = weak.map(w => `${w.name} ${w.missed} рет қалды`).join('\n');

        text += `${visualList}\n`;
        text += `🏆 *Үздіктер (6 күн толық оқығандар):*\n${best.length > 0 ? best.join(', ') : 'Жоқ'}\n\n`;
        text += `👍 *Жақсы нәтиже (4-5 күн):*\n${good.length > 0 ? good.join(', ') : 'Жоқ'}\n\n`;
        text += `⚠️ *Көбірек назар аудару керек (3+ күн қалып қойғандар):*\n${weakText || 'Жоқ'}\n`;
        text += "----------------------\n";
    }

    text += `\n✅ Уақытында | 🟧 Кешігіп оқыды | ❌ Оқымады\n`;
    text += `\n💡 *Қарызды жабу:* ❌ белгісі бар күннің таңғы тапсырмасына *+* деп жауап жазыңыз!\n`;
    text += `\n⚠️ *Ескерту!* Кім Хатым біткенде ең көп кешіккен/оқымаған болса, осы бағдарламаның ақысын төлейді!!!`;

    await safeSendWithMentions(targetJid, text, db.users_1);
}

async function sendKhatmStats(groupType, dateStr) {
    let text = "";
    let userList = db.users_1.filter(u => u);
    let historyObj = db.history_1;
    let khatymNum = db.khatymCount_1++;
    let totalDays = 30;
    let title = "ҚҰРАН ХАТЫМ";

    let khatymDates = getLastWorkingDates(dateStr, totalDays);
    const startDateObj = new Date(START_DATE + 'T00:00:00');
    khatymDates = khatymDates.filter(d => new Date(d + 'T00:00:00') >= startDateObj);
    const actualDays = khatymDates.length > 0 ? khatymDates.length : 1;

    text += `🎉 *АЛЛАҺУ ӘКБАР!*\n` +
        `🏆 *${title}* ортақ\n` +
        `*№${khatymNum} ХАТЫМДЫ* толық аяқтады! 🤲\n` +
        `───────────────\n` +
        `📅 Кезең: ${formatDateToKazakh(khatymDates[0])} — ${formatDateToKazakh(khatymDates[khatymDates.length - 1])}\n\n`;

    let best = [];
    let lateFinishers = [];
    let weak = [];
    let maxMissed = 0;

    for (let uid of userList) {
        let presentCount = 0;
        let lateCount = 0;
        let userName = `@${uid.split('@')[0]}`;

        for (let d of khatymDates) {
            let reads = historyObj[d] || [];
            if (includesUser(reads, uid)) presentCount++;
            else if (db.late_1[d] && includesUser(db.late_1[d], uid)) lateCount++;
        }

        const missedDays = actualDays - presentCount - lateCount;

        if (missedDays === 0 && lateCount === 0) {
            best.push(userName);
        } else if (missedDays === 0 && lateCount > 0) {
            lateFinishers.push({ name: userName, late: lateCount });
        } else {
            weak.push({ name: userName, missed: missedDays, uid: uid });
            if (missedDays > maxMissed) maxMissed = missedDays;
        }
    }

    weak.sort((a, b) => a.missed - b.missed);
    let weakText = weak.map(w => `${w.name} ${w.missed} рет қалды`).join('\n');
    let lateText = lateFinishers.map(l => `${l.name} (${l.late} рет кешікті)`).join(', ');

    text += `🥇 *Толық ${actualDays} күнді үзбей оқығандар:*\n${best.length > 0 ? best.join(', ') : 'Жоқ'}\n\n`;
    if (lateFinishers.length > 0) {
        text += `🟧 *Барлығын оқығандар (кешігіп):*\n${lateText}\n\n`;
    }
    text += `🥈 *Кешігіп оқығандар:*\n${weakText || 'Жоқ'}\n` +
        `───────────────\n\n`;
    text += `⚠️ *ЕСКЕРТУ!*\nКім Хатым біткенде ең көп кешіккен/оқымаған болса, бағдарламаның ақысын төлейді!\n\n`;

    if (maxMissed > 0) {
        const losers = weak.filter(w => w.missed === maxMissed).map(w => w.name);
        text += `💸 *Мына қатысушы(лар) бағдарламаны қолдану ақысын төлейді:*\n`;
        text += losers.join(', ') + "\n\n";
    }

    const currentDate = new Date(dateStr + 'T00:00:00');
    currentDate.setDate(currentDate.getDate() + 1);
    const isTomorrowSunday = (currentDate.getDay() === 0);
    let nextStartText = isTomorrowSunday ? "дүйсенбі күні" : "ертең";

    text += `🤲 Алла Тағала оқыған Құранымызды қабыл етсін! Келесі жаңа Хатым *${nextStartText}* басталады (ИншаАллаһ)!`;
    await safeSendWithMentions(GROUP_ID, text, userList);

    for (let uid of userList) {
        if (db.strikes && db.strikes[uid]) delete db.strikes[uid];
    }
    saveDb();
}

let tasksScheduled = false;
function scheduleTasks() {
    if (tasksScheduled) return;
    tasksScheduled = true;
    cron.schedule('0 6 * * 1-6', () => sendMorningTask(getAlmatyDateStr()), { timezone: TIMEZONE });
    cron.schedule('0 21 * * 1-5', () => sendWarning(3), { timezone: TIMEZONE });
    cron.schedule('59 23 * * 1-5', () => sendDeadline(getAlmatyDateStr()), { timezone: TIMEZONE });
    cron.schedule('0 21 * * 6', () => sendWarning(0, true), { timezone: TIMEZONE });
    cron.schedule('0 21 * * 0', () => sendWarning(3), { timezone: TIMEZONE });
    cron.schedule('59 23 * * 0', () => sendDeadline(getAlmatyDateStr()), { timezone: TIMEZONE });

    // Персональды DM — күн сайын 22:00-де тексеру (аптасына 1 рет жібереді)
    cron.schedule('0 22 * * 1-6', () => sendPersonalReminders(), { timezone: TIMEZONE });

    // Рамазанға кері санақ — күн сайын таңғы 06:05-те тексеру
    cron.schedule('5 6 * * 1-6', () => checkRamadanCountdown(), { timezone: TIMEZONE });
}


// Базовые эмодзи без модификаторов — проверяем через stripEmojiModifiers
const VALID_REACTIONS_BASE = ['👍', '❤', '✅', '➕'];

/**
 * Проверяет, является ли эмодзи допустимой реакцией.
 * Очищает от skin tone модификаторов и variation selectors.
 */
function isValidReaction(emoji) {
    if (!emoji) return false;
    const stripped = stripEmojiModifiers(emoji);
    return VALID_REACTIONS_BASE.includes(stripped);
}

/**
 * Ищет targetMsgId в pastMsgIds_1, учитывая что старые записи могут
 * храниться в формате полного Baileys ключа (true_groupId_msgId_senderJid).
 */
function findPastMsgDate(targetMsgId) {
    if (!db.pastMsgIds_1) return null;
    // 1. Прямое совпадение (новый формат — короткий ID)
    if (db.pastMsgIds_1[targetMsgId]) {
        return db.pastMsgIds_1[targetMsgId];
    }
    // 2. Поиск в старых ключах формата "true_groupJid_MSGID_senderJid"
    for (const fullKey of Object.keys(db.pastMsgIds_1)) {
        if (fullKey.includes('_')) {
            const parts = fullKey.split('_');
            // parts: ["true", groupJid, msgId, senderJid]
            if (parts.length >= 3 && parts[2] === targetMsgId) {
                return db.pastMsgIds_1[fullKey];
            }
        }
    }
    return null;
}

async function handleReaction(senderId, targetMsgId, emoji) {
    try {
        console.log(`\n=== 🛠 DEBUG: handleReaction ===`);
        console.log(`1. senderId: ${senderId}`);
        console.log(`2. targetMsgId: ${targetMsgId}`);
        console.log(`3. emoji (raw): ${emoji}`);
        console.log(`4. expected msgId_1: ${db.today.msgId_1}`);
        console.log(`5. isGroup1Task: ${db.today.msgId_1 === targetMsgId}`);
        console.log(`6. isInUsers1: ${includesUser(db.users_1, senderId)}`);
        console.log(`================================\n`);

        // ═══════════════════════════════════════════════════════
        // 🔍 DEBUG: Детальная информация о реакции
        // ═══════════════════════════════════════════════════════
        const inGroup1 = includesUser(db.users_1, senderId);
        const strippedEmoji = emoji ? stripEmojiModifiers(emoji) : null;
        console.log(`\n${'═'.repeat(55)}`);
        console.log(`🔔 РЕАКЦИЯ КЕЛДІ`);
        console.log(`${'─'.repeat(55)}`);
        console.log(`  📨 Хабарлама ID (target):  ${targetMsgId}`);
        console.log(`  📋 Күтілетін msgId_1:      ${db.today.msgId_1}`);
        console.log(`  🆔 Кім қойды (senderId):   ${senderId}`);
        console.log(`  🔢 Нормализованный ID:     ${normalizeId(senderId)}`);
        console.log(`  👥 users_1 ішінде бар ма:  ${inGroup1}`);
        console.log(`  😀 Эмодзи (raw):           ${emoji ? `"${emoji}" (codepoints: ${[...emoji].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ')})` : '(жойылды)'}`);
        console.log(`  😀 Эмодзи (stripped):      ${strippedEmoji ? `"${strippedEmoji}"` : '(жойылды)'}`);
        console.log(`  ✅ Жарамды реакция ма:     ${isValidReaction(emoji)}`);
        console.log(`  📊 read_1 саны:            ${db.today.read_1.length}/${db.users_1.length}`);
        console.log(`${'═'.repeat(55)}\n`);
        // ═══════════════════════════════════════════════════════

        // --- Тіркелу хабарламасына реакция ---
        if (targetMsgId === db.regMsgId_1) {
            if (emoji && isValidReaction(emoji)) {
                if (getAlmatyDateStr() === START_DATE) {
                    if (!includesUser(db.users_1, senderId)) {
                        db.users_1.push(senderId);
                        console.log(`Тіркелді (1-пара): ${senderId}`);
                    }
                }
            } else if (!emoji && getAlmatyDateStr() === START_DATE) {
                const matchId = findMatchingId(db.users_1, senderId);
                if (matchId) db.users_1 = db.users_1.filter(u => u !== matchId);
            }
            saveDb();
            return;
        }

        // --- Бүгінгі тапсырмаға реакция ма? ---
        let isGroup1Task = (db.today.msgId_1 === targetMsgId);
        let isLateTask = false;
        let lateDate = null;

        if (!isGroup1Task) {
            // pastMsgIds_1 ішінен іздеу (ескі толық кілтпен де, жаңа қысқа ID-мен де)
            lateDate = findPastMsgDate(targetMsgId);
            if (lateDate) {
                isLateTask = true;
                console.log(`📌 pastMsgIds_1-ден табылды: targetMsgId=${targetMsgId} -> ${lateDate}`);
            } else {
                console.log(`⏭️ targetMsgId=${targetMsgId} — бұл бізге қатысты емес хабарлама, өткіземіз.`);
                return;
            }
        }

        if (emoji) {
            if (!isValidReaction(emoji)) {
                console.log(`⏭️ Жарамсыз реакция: "${emoji}" (stripped: "${strippedEmoji}"), өткіземіз.`);
                return;
            }
            if (isLateTask) {
                if (!inGroup1) { console.log(`⏭️ ${senderId} users_1 тобында жоқ, өткіземіз.`); return; }
                if (db.history_1[lateDate] && includesUser(db.history_1[lateDate], senderId)) return;
                if (!db.late_1[lateDate]) db.late_1[lateDate] = [];
                if (!includesUser(db.late_1[lateDate], senderId)) {
                    db.late_1[lateDate].push(senderId);
                    if (db.strikes) {
                        const strikeId = findMatchingId(Object.keys(db.strikes), senderId);
                        if (strikeId && db.strikes[strikeId] > 0) db.strikes[strikeId]--;
                    }
                    console.log(`🟧 Кешігіп оқыды: ${senderId} -> ${lateDate}`);
                }
            } else if (isGroup1Task) {
                if (!inGroup1) { console.log(`⏭️ ${senderId} users_1 тобында жоқ, өткіземіз.`); return; }
                if (!includesUser(db.today.read_1, senderId)) {
                    db.today.read_1.push(senderId);
                    console.log(`✅ Оқыды деп белгіленді: ${senderId} (read_1: ${db.today.read_1.length}/${db.users_1.length})`);
                }
            }
        } else {
            // Реакция жойылды
            if (isLateTask) {
                if (db.late_1[lateDate]) {
                    const matchId = findMatchingId(db.late_1[lateDate], senderId);
                    if (matchId) {
                        const idx = db.late_1[lateDate].indexOf(matchId);
                        if (idx > -1) db.late_1[lateDate].splice(idx, 1);
                    }
                }
            } else {
                const matchId = findMatchingId(db.today.read_1, senderId);
                if (matchId) {
                    const idx = db.today.read_1.indexOf(matchId);
                    if (idx > -1) db.today.read_1.splice(idx, 1);
                }
            }
        }
        saveDb();

        // --- Барлығы оқып бітті ме? Ерте дедлайн жабу ---
        if (emoji && !isLateTask) {
            await checkAllReadAndCloseEarly();
        }
    } catch (e) {
        console.error("Реакцияны өңдеуде қате:", e);
    }
}

/**
 * Егер барлық қатысушылар ағымдағы тапсырманы оқып бітірсе — дедлайнды ерте жабады.
 * Реакция арқылы да, "+" жауабы арқылы да белгіленгенде шақырылады.
 */
async function checkAllReadAndCloseEarly() {
    if (!db.today.msgId_1) return;
    const validUsers1 = db.users_1.filter(u => u);
    if (validUsers1.length === 0) return;
    const allRead1 = validUsers1.every(u => includesUser(db.today.read_1, u));
    if (!allRead1) return;

    try {
        const dateStr = db.today.date || getAlmatyDateStr();
        db.history_1[dateStr] = [...db.today.read_1];

        await sock.sendMessage(GROUP_ID, {
            text: `✅ *МашаАллаһ!*\nБүгін барлық қатысушылар тапсырманы ерте аяқтады!\nДедлайн жабылды. Алла разы болсын! 🤲`
        });

        const count = getWorkingDaysCount(dateStr);
        const juz1 = getJuz1(count);

        if (juz1 === 30) await sendKhatmStats('GROUP_1', dateStr);

        const dObj = new Date(dateStr + 'T00:00:00');
        if (dObj.getDay() === 6) {
            await sendWeeklyStats(GROUP_ID, dateStr);
        }

        if (db.today.msgId_1) {
            if (!db.pastMsgIds_1) db.pastMsgIds_1 = {};
            db.pastMsgIds_1[db.today.msgId_1] = dateStr;
        }
        db.today.msgId_1 = null;
        saveDb();
        console.log("🎉 Барлығы оқып бітті. Дедлайн ерте жабылды!");
    } catch (e) {
        console.error("Ерте дедлайн жабуда қате шықты:", e);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('Пожалуйста, отсканируйте QR-код выше!');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ WhatsApp байланысы үзілді! Себебі:', lastDisconnect.error);

            if (shouldReconnect) {
                console.log('🔄 Қайта қосылу басталды...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('🔴 Сессия жарамсыз. auth_info_baileys папкасын өшіріп, QR-кодты қайта сканерлеңіз.');
                sendTelegramAlert(`🔴 WhatsApp авторизация ҚАТЕСІ! QR-кодпен қайта кіріңіз.`);
            }
        } else if (connection === 'open') {
            console.log('✅ Khatym Bot (Baileys) сәтті іске қосылды!');
            scheduleTasks();
        }
    });

    // Baileys реакцияларды осы оқиға арқылы жібереді
    sock.ev.on('messages.reaction', async (reactions) => {
        console.log('\n=============================================');
        console.log('🔥 RAW EVENT: messages.reaction');
        console.log(JSON.stringify(reactions, null, 2));
        console.log('=============================================\n');
        for (const reaction of reactions) {
            try {
                // reaction.key — бұл реакция қойылған ХАБАРЛАМА (target message)
                // reaction.key.id — сол хабарламаның ID-сі
                const targetMsgId = reaction.key.id;

                // reaction.reaction.text — эмодзи (бос строка = реакция жойылды)
                const emoji = reaction.reaction?.text || '';

                // Реакцияны КІМ қойды?
                // Baileys-те: reaction.key.participant = хабарлама авторы (group-та),
                // ал реакцияны қойған адам бірнеше жерде болуы мүмкін:
                //   1) reaction.reaction.key.participant (group chat)
                //   2) reaction.reaction.key.remoteJid (private chat / fallback)
                //   3) Кейде Baileys versions-та reaction.reaction.key.fromMe болса — sock.user.id
                let reactorJid = reaction.reaction?.key?.participant
                    || reaction.reaction?.key?.remoteJid;

                // Егер fromMe болса — бот өзінің реакциясы
                if (!reactorJid && reaction.reaction?.key?.fromMe) {
                    reactorJid = sock.user?.id;
                }

                if (!reactorJid) {
                    console.log('⚠️ messages.reaction: reactorJid анықталмады!');
                    console.log('  Толық reaction объектісі:', JSON.stringify(reaction, null, 2));
                    continue;
                }

                // LID → нақты номерге резолвинг
                const resolvedJid = await resolveRealJid(reactorJid, reaction.key.remoteJid || GROUP_ID);
                const senderId = cleanUserId(resolvedJid);
                console.log(`📥 messages.reaction event: reactor=${reactorJid} -> resolved=${resolvedJid} -> cleaned=${senderId}, target=${targetMsgId}`);
                await handleReaction(senderId, targetMsgId, emoji || null);
            } catch (e) {
                console.error('messages.reaction өңдеуде қате:', e);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const chatId = msg.key.remoteJid;
            const botJid = cleanUserId(sock.user.id);

            // LID резолвинг — rawSenderJid-ді нақты номерге аударамыз
            let rawSenderJid = msg.key.participant || msg.key.remoteJid;
            if (!msg.key.fromMe && rawSenderJid) {
                rawSenderJid = await resolveRealJid(rawSenderJid, chatId);
            }
            const senderId = msg.key.fromMe ? botJid : cleanUserId(rawSenderJid);
            const msgId = msg.key.id;

            let actualMessage = msg.message;
            if (actualMessage?.ephemeralMessage) actualMessage = actualMessage.ephemeralMessage.message;
            if (actualMessage?.viewOnceMessageV2) actualMessage = actualMessage.viewOnceMessageV2.message;

            if (actualMessage?.reactionMessage) {
                const reaction = actualMessage.reactionMessage;
                const targetMsgId = reaction.key.id;
                const emoji = reaction.text;
                // messages.upsert арқылы келген реакция:
                // msg.key.participant = реакцияны қойған адам (group chat)
                // msg.key.remoteJid = fallback (private chat)
                const reactorJid = msg.key.participant || msg.key.remoteJid;

                console.log('\n=============================================');
                console.log('🔥 RAW EVENT: messages.upsert (reaction)');
                console.log(`reactorJid: ${reactorJid}`);
                console.log(`targetMsgId: ${targetMsgId}`);
                console.log(`emoji: ${emoji}`);
                console.log('=============================================\n');

                // LID → нақты номер резолвинг
                const resolvedReactorJid = await resolveRealJid(reactorJid, chatId);
                const reactSenderId = cleanUserId(resolvedReactorJid);
                console.log(`📥 Реакция (upsert): reactor=${reactorJid} -> resolved=${resolvedReactorJid} -> cleaned=${reactSenderId}, target=${targetMsgId}, emoji=${emoji || '(removed)'}`);
                await handleReaction(reactSenderId, targetMsgId, emoji || null);
                return;
            }

            const messageText = actualMessage?.conversation || actualMessage?.extendedTextMessage?.text || actualMessage?.imageMessage?.caption || actualMessage?.videoMessage?.caption || '';
            if (!messageText) continue;

            const quotedMsg = actualMessage?.extendedTextMessage?.contextInfo?.quotedMessage;
            let quotedActual = quotedMsg;
            if (quotedActual?.ephemeralMessage) quotedActual = quotedActual.ephemeralMessage.message;
            const quotedText = quotedActual?.conversation || quotedActual?.extendedTextMessage?.text || quotedActual?.imageMessage?.caption || '';

            if (quotedText && messageText.trim() === '+') {
                const dateMatch = quotedText.match(/Күн: \*(\d{2})\.(\d{2})\.(\d{4})\*/);
                if (dateMatch) {
                    const taskDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
                    if (includesUser(db.users_1, senderId)) {
                        if (db.history_1[taskDate] && includesUser(db.history_1[taskDate], senderId)) return;
                        if (taskDate === db.today.date && includesUser(db.today.read_1, senderId)) return;

                        // Ағымдағы тапсырма (дедлайн әлі өтпеген) — уақытында оқыды деп есептейміз
                        if (taskDate === db.today.date && db.today.msgId_1) {
                            db.today.read_1.push(senderId);
                            // Бұрын қате түрде кешігу ретінде жазылған болса — алып тастаймыз
                            if (db.late_1[taskDate]) {
                                const lateMatch = findMatchingId(db.late_1[taskDate], senderId);
                                if (lateMatch) db.late_1[taskDate] = db.late_1[taskDate].filter(u => u !== lateMatch);
                            }
                            saveDb();
                            console.log(`✅ Жауап (+) арқылы уақытында оқыды: ${senderId} -> ${taskDate} (read_1: ${db.today.read_1.length}/${db.users_1.length})`);
                            await checkAllReadAndCloseEarly();
                            return;
                        }

                        if (!db.late_1[taskDate]) db.late_1[taskDate] = [];
                        if (!includesUser(db.late_1[taskDate], senderId)) {
                            db.late_1[taskDate].push(senderId);
                            const strikeId = findMatchingId(Object.keys(db.strikes || {}), senderId);
                            if (strikeId && db.strikes[strikeId] > 0) {
                                db.strikes[strikeId]--;
                            }
                            saveDb();
                            console.log(`🟧 Жауап арқылы кешігіп оқыды: ${senderId} -> ${taskDate}`);
                        }
                    }
                    return;
                }
            }

            const reply = async (text, mentions = []) => {
                const safeMentions = mentions.map(toBaileysJid);
                await sock.sendMessage(chatId, {
                    text: text,
                    mentions: safeMentions.length > 0 ? safeMentions : undefined
                }, { quoted: msg });
            };

            if (messageText.startsWith('!add_new')) {
                const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (mentionedJids.length === 0) reply(`⚠️ Қате! Адамдарды белгілеңіз. Мысалы: !add_new @Адам1 @Адам2`);

                for (let jid of mentionedJids) {
                    let uid = cleanUserId(jid);
                    if (!db.users_1.includes(uid)) db.users_1.push(uid);
                    for (let date in db.history_1) {
                        if (!db.history_1[date].includes(uid)) db.history_1[date].push(uid);
                    }
                    if (db.today.date && !db.today.read_1.includes(uid)) {
                        db.today.read_1.push(uid);
                    }
                }
                saveDb();
                reply(`✅ Сәтті орындалды! Белгіленген ${mentionedJids.length} адам 1-пара тобына қосылды және олардың осыған дейінгі барлық қарыздары жабылды.`);
            }

            if (messageText === '!help' || messageText === '!команды') {
                const helpText = `🛠 *БОТ КОМАНДАЛАРЫ (АДМИН)* 🛠\n` +
                    `_Бұл командаларды кез келген чатта (Топта немесе Жеке чатта/Избранное) жазуға болады. Жауап осы чатқа келеді._\n\n` +
                    `*Тапсырмалар мен Есептер:*\n` +
                    `▫️ *!force_task* — Таңғы тапсырманы қазір мәжбүрлі түрде негізгі топқа жіберу (жексенбіде жұмыс істемейді; ашық тапсырма болса — *!force_task confirm*)\n` +
                    `▫️ *!force_warning* — Кешкі ескертуді негізгі топқа жіберу\n` +
                    `▫️ *!force_deadline* — Дедлайнды жабу (негізгі топқа жіберіледі)\n` +
                    `▫️ *!force_weekly* — Апталық есепті *осы чатқа* жіберу\n` +
                    `▫️ *!daily_stat* — Бүгінгі оқыған/оқымағандардың тізімін *осы чатқа* шығару\n` +
                    `▫️ *!status* — Қысқаша статистика (Қанша адам оқыды)\n` +
                    `▫️ *!all_ids* — Базадағы барлық адамдардың тізімі мен ID-лері\n\n` +
                    `*Адамдарды басқару:*\n` +
                    `▫️ *!add_new @Адам* — Адамды базаға қосып, өткен қарыздарының бәрін жабу\n` +
                    `▫️ *!add_id 7701...* — Адамды номері (ID) арқылы үнсіз қосу\n` +
                    `▫️ *!remove_id 7701...* — Адамды базадан үнсіз өшіру\n` +
                    `▫️ *!add_ids ID1 ID2...* — Бірнеше ID-ді бірден қосу\n` +
                    `▫️ *!remove_all* — 1-пара тобындағы барлық адамды өшіру (Тазалау)\n\n` +
                    `*Қарыздар мен Белгілеулер:*\n` +
                    `▫️ *!mark_read ID today* (немесе Күн) — Адамды оқыды деп белгілеу\n` +
                    `▫️ *!mark_read_all today* — Барлық адамды оқыды деп белгілеу\n` +
                    `▫️ *!unmark_ids today ID* — Адамнан 'оқыды' белгісін алып тастау\n` +
                    `▫️ *!forgive_past* — Барлық адамның өткен қарыздарын жабу (Бүгіннен басқа)\n\n` +
                    `*Техникалық (LID/Веб-версия үшін):*\n` +
                    `▫️ *!link_lid LID НӨМІР* — Жасырын LID-ді нақты нөмірге байлау (мысалы: !link_lid 19380... 7701...)\n\n` +
                    `*Уақыт машинасы (Тест үшін):*\n` +
                    `▫️ *!setdate ЖЖЖЖ-АА-КК* — Бот үшін бүгінгі күнді өзгерту (Мысалы: !setdate 2026-03-25)\n` +
                    `▫️ *!resetdate* — Нақты уақытқа қайту\n\n` +
                    `💡 _Кешігіп оқу үшін:_ Ескі тапсырма хабарламасына (reply) *+* деп жауап беру керек.`;
                reply(helpText);
            }

            if (messageText.startsWith('!setdate ')) {
                const newDate = messageText.split(' ')[1];
                if (/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
                    simulatedDate = newDate;
                    reply(`⏱ *Уақыт машинасы қосылды!*\nЕнді бот үшін бүгінгі күн: *${simulatedDate}*\n\nТест үшін !force_task немесе !force_weekly жіберіп көріңіз.`);
                } else {
                    reply(`⚠️ Қате формат! Былай жазыңыз: !setdate ЖЖЖЖ-АА-КК (мысалы: !setdate 2026-03-25)`);
                }
            }

            if (messageText === '!resetdate') {
                simulatedDate = null;
                reply(`⏱ *Уақыт машинасы өшірілді.*\nБот нақты уақытқа оралды: *${getAlmatyDateStr()}*`);
            }

            if (messageText.startsWith('!link_lid ')) {
                const parts = messageText.split(/\s+/);
                if (parts.length < 3) {
                    reply("⚠️ Қате! Үлгі: !link_lid 123456789012345 77001234567");
                    return;
                }
                const lidRaw = parts[1];
                const realRaw = parts[2];
                const lidNum = lidRaw.replace(/\D/g, '');
                const realId = cleanUserId(realRaw);

                if (!db.lid_map) db.lid_map = {};
                db.lid_map[lidNum] = realId;

                // Егер бұл LID users_1 ішінде қалып қойса, оны өшіреміз
                const lidAsUser = lidNum + '@c.us';
                if (db.users_1.includes(lidAsUser)) {
                    db.users_1 = db.users_1.filter(u => u !== lidAsUser);
                }
                if (db.today.read_1.includes(lidAsUser)) {
                    db.today.read_1 = db.today.read_1.filter(u => u !== lidAsUser);
                    if (!db.today.read_1.includes(realId)) {
                        db.today.read_1.push(realId);
                    }
                }

                saveDb();
                reply(`✅ LID ${lidNum} сәтті нақты нөмірге (${realId}) байланыстырылды!\nЕнді сіздің реакцияларыңыз дұрыс есептеледі.`);
                return;
            }

            if (messageText === '!force_task' || messageText === '!force_task confirm') {
                const forceDateStr = getAlmatyDateStr();
                const isSunday = new Date(forceDateStr + 'T00:00:00').getDay() === 0;
                const hasOpenTask = !!db.today.msgId_1;
                const confirmed = messageText === '!force_task confirm';

                if (isSunday) {
                    reply(`⛔ *Бүгін жексенбі — демалыс күні!*\n` +
                        `Жексенбіде таңғы тапсырма жіберілмейді.\n` +
                        `Сенбілік тапсырманың дедлайны бүгін 23:59-да жабылады.`);
                    return;
                }
                if (hasOpenTask && !confirmed) {
                    reply(`⚠️ *Назар аударыңыз!*\n` +
                        `Әлі жабылмаған тапсырма бар: *${formatDateToKazakh(db.today.date)}* ` +
                        `(оқығандар: ${db.today.read_1.length}/${db.users_1.length}).\n\n` +
                        `Жаңа тапсырма жіберсеңіз, ол ескі тапсырманың орнын басады ` +
                        `және бүгінгі белгілер жоғалуы мүмкін.\n\n` +
                        `Сенімді болсаңыз: *!force_task confirm*`);
                    return;
                }
                reply('⏳ Тапсырма жіберілуде...');
                await sendMorningTask(forceDateStr);
            }
            if (messageText === '!force_warning') {
                await sendWarning(2);
                reply("✅ Warning топқа жіберілді!");
            }
            if (messageText === '!force_deadline') {
                await sendDeadline(getAlmatyDateStr());
            }
            if (messageText === '!force_weekly') {
                await sendWeeklyStats(chatId, getAlmatyDateStr());
                reply("✅ Апталық есеп жіберілді!");
            }
            if (messageText === '!send_reg') {
                await sendRegistrationMessages();
            }
            if (messageText === '!month') {
                await sendKhatmStats('GROUP_1', '2026-03-21');
            }
            if (messageText === '!status') {
                const dateStr = db.today.date || getAlmatyDateStr();
                const read = db.today.read_1;
                const missed = db.users_1.filter(u => !includesUser(read, u));
                let text = `📅 Күн: ${dateStr}\n👥 Оқығандар: ${read.length}/${db.users_1.length}\n───────────────\n\n`;
                text += `✅ *Оқығандар:*\n`;
                for (let uid of read) text += `@${uid.split('@')[0]} `;
                text += `\n\n❌ *Оқымағандар:*\n`;
                for (let uid of missed) text += `@${uid.split('@')[0]} `;
                reply(text, db.users_1);
            }
            if (messageText === '!all_ids') {
                reply("📋 *ҚАТЫСУШЫЛАРДЫҢ ID ТІЗІМІ:*\n" + db.users_1.join('\n'));
            }
            if (messageText.startsWith('!remove_id ')) {
                const targetId = messageText.split(' ')[1];
                db.users_1 = db.users_1.filter(u => u !== targetId);
                saveDb();
                reply(`✅ Адам базадан өшірілді.`);
            }
            if (messageText.startsWith('!add_id ')) {
                let uid = messageText.split(' ')[1];
                uid = cleanUserId(uid);
                if (!db.users_1.includes(uid)) {
                    db.users_1.push(uid);
                    reply(`✅ Өзіңіз (немесе адам) базаға сәтті қосылды: ${uid}`);
                } else {
                    reply(`⚠️ Бұл ID базада онсыз да бар.`);
                }
                saveDb();
            }
            if (messageText.startsWith('!mark_read ')) {
                const parts = messageText.split(' ');
                if (parts.length < 3) reply("⚠️ Қате! Үлгі: !mark_read ID 2026-04-04");
                const uid = parts[1];
                const dateStr = parts[2];
                if (dateStr === 'today') {
                    if (!db.today.read_1.includes(uid)) db.today.read_1.push(uid);
                    reply(`✅ ${uid} -> Бүгінге (today) "оқыды" деп белгіленді!`);
                } else {
                    if (!db.history_1[dateStr]) db.history_1[dateStr] = [];
                    if (!db.history_1[dateStr].includes(uid)) db.history_1[dateStr].push(uid);
                    reply(`✅ ${uid} -> ${dateStr} күніне "оқыды" деп белгіленді!`);
                }
                saveDb();
            }
            if (messageText === '!remove_all') {
                db.users_1 = [];
                db.today.read_1 = [];
                saveDb();
                reply('🗑️ Список участников 1-й группы полностью очищен.');
            }
            if (messageText.startsWith('!add_ids ')) {
                const parts = messageText.split(/\s+/);
                const newIds = parts.slice(1);
                let addedCount = 0;
                for (let id of newIds) {
                    const cleanId = cleanUserId(id.trim());
                    if (cleanId && !db.users_1.includes(cleanId)) {
                        db.users_1.push(cleanId);
                        for (let date in db.history_1) {
                            if (!db.history_1[date].includes(cleanId)) db.history_1[date].push(cleanId);
                        }
                        addedCount++;
                    }
                }
                saveDb();
                reply(`✅ Успешно добавлено ${addedCount} новых ID в базу.`);
            }
            if (messageText.startsWith('!mark_read_all')) {
                const parts = messageText.split(' ');
                const dateArg = parts[1] || 'today';
                const targetDate = (dateArg === 'today') ? (db.today.date || getAlmatyDateStr()) : dateArg;
                let addedCount = 0;
                if (dateArg === 'today') {
                    for (let uid of db.users_1) {
                        if (!db.today.read_1.includes(uid)) {
                            db.today.read_1.push(uid);
                            addedCount++;
                        }
                    }
                } else {
                    if (!db.history_1[targetDate]) db.history_1[targetDate] = [];
                    for (let uid of db.users_1) {
                        if (!db.history_1[targetDate].includes(uid)) {
                            db.history_1[targetDate].push(uid);
                            addedCount++;
                        }
                    }
                }
                saveDb();
                reply(`✅ Все участники (${db.users_1.length} чел.) отмечены как "прочитавшие" за ${targetDate}.\nОбновлено записей: ${addedCount}`);
            }
            if (messageText.startsWith('!unmark_ids ')) {
                const parts = messageText.split(/\s+/);
                if (parts.length < 3) reply("⚠️ Ошибка! Формат: !unmark_ids <today или дата> <ID1> <ID2> ...");
                const dateArg = parts[1];
                const targetIds = parts.slice(2);
                let removedCount = 0;
                if (dateArg === 'today') {
                    for (let uid of targetIds) {
                        const cleanId = uid.trim();
                        const idx = db.today.read_1.indexOf(cleanId);
                        if (idx > -1) {
                            db.today.read_1.splice(idx, 1);
                            removedCount++;
                        }
                    }
                    reply(`✅ Снята отметка "прочитал" за сегодня (today) для ${removedCount} ID.`);
                } else {
                    if (db.history_1[dateArg]) {
                        for (let uid of targetIds) {
                            const cleanId = uid.trim();
                            const idx = db.history_1[dateArg].indexOf(cleanId);
                            if (idx > -1) {
                                db.history_1[dateArg].splice(idx, 1);
                                removedCount++;
                            }
                        }
                        reply(`✅ Снята отметка "прочитал" за ${dateArg} для ${removedCount} ID.`);
                    } else {
                        reply(`⚠️ За дату ${dateArg} в истории нет записей.`);
                    }
                }
                saveDb();
            }
            if (messageText === '!forgive_past') {
                let updateCount = 0;
                const todayStr = db.today.date || getAlmatyDateStr();
                for (let dateStr in db.history_1) {
                    if (dateStr === todayStr) continue;
                    for (let uid of db.users_1) {
                        if (!db.history_1[dateStr].includes(uid)) {
                            db.history_1[dateStr].push(uid);
                            updateCount++;
                        }
                    }
                }
                saveDb();
                reply(`✅ Барлық қатысушылардың өткен күндердегі қарыздары толық жабылды!\nӨзгертілген жазба саны: ${updateCount}.\n⚠️ Бүгінгі (${todayStr}) тапсырмаға тиіскен жоқпын.`);
            }
            if (messageText === '!fill_week') {
                const missingDates = ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04'];
                for (let d of missingDates) {
                    db.history_1[d] = [...db.users_1];
                }
                saveDb();
                reply("✅ Осы аптаның тарихы қалпына келтірілді және барлық адамға 'оқыды' деп жабылды!");
            }
            if (messageText.startsWith('!mark_late ')) {
                const parts = messageText.split(' ');
                if (parts.length < 3) reply("⚠️ Қате! Үлгі: !mark_late ID 2026-05-26");
                const uid = parts[1];
                const dateStr = parts[2];
                if (db.history_1[dateStr] && db.history_1[dateStr].includes(uid)) {
                    reply(`⚠️ Бұл адам ${dateStr} күнін уақытында оқып қойған.`);
                }
                if (!db.late_1[dateStr]) db.late_1[dateStr] = [];
                if (!db.late_1[dateStr].includes(uid)) {
                    db.late_1[dateStr].push(uid);
                    if (db.strikes && db.strikes[uid] && db.strikes[uid] > 0) db.strikes[uid]--;
                    reply(`🟧 ${uid} -> ${dateStr} күніне "кешігіп оқыды" деп белгіленді!`);
                } else {
                    reply(`⚠️ Бұл адам ${dateStr} күніне кешігіп оқыды деп онсыз да белгіленген.`);
                }
                saveDb();
            }
            if (messageText === '!daily_stat') {
                const dateStr = db.today.date || getAlmatyDateStr();
                const read = db.today.read_1;
                const missed = db.users_1.filter(u => !includesUser(read, u));
                let text = `📊 *КҮНДЕЛІКТІ ЕСЕП*\n📅 ${formatDateToKazakh(dateStr)}\n───────────────\n\n`;
                text += `✅ *Оқығандар (${read.length}):*\n`;
                for (let uid of read) text += `@${uid.split('@')[0]} `;
                text += `\n\n❌ *Оқымағандар (${missed.length}):*\n`;
                for (let uid of missed) text += `@${uid.split('@')[0]} `;
                reply(text, db.users_1);
            }
        }
    });
}

connectToWhatsApp();

setInterval(() => {
    try {
        const state = sock ? 'CONNECTED' : 'NOT_READY';
        const memUsage = process.memoryUsage();
        const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        console.log(`💓 Health check: state=${state}, heap=${heapMB}MB, today=${db.today.date}`);

        if (heapMB > 1024) {
            console.warn('⚠️ Жады тым көп қолданылып жатыр! Restart ұсынылады.');
            sendTelegramAlert(`⚠️ Бот жадысы ${heapMB}MB-қа жетті! Тұрақсыз болуы мүмкін.`);
        }
    } catch (e) {
        console.error('Health check қатесі:', e.message);
    }
}, 30 * 60 * 1000);
