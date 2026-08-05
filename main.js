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

const GROUP_ID = process.env.GROUP_ID || '120363420625638158@g.us';
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
    }
};

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

    } catch (e) {
        console.error("Тапсырма жіберуде қате шықты:", e);
    }
}

async function sendWarning(hour, isSatSpecial = false) {
    if (!db.today.msgId_1) return;

    try {
        const validUsers1 = db.users_1.filter(u => u);
        const debtors1 = validUsers1.filter(u => !db.today.read_1.includes(u));
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

        let text = "";
        if (isSatSpecial) {
            text = `⚠️ *ЕСКЕРТУ*\nСенбілік тапсырманың дедлайны **ертең (Жексенбі)** кешке дейін!\nҮлгермеген қатысушылар үшін уақыт әлі бар.\n───────────────\n\n`;
        } else {
            text = `⚠️ *ЕСКЕРТУ*\nЕсеп беру уақытының аяқталуына *${hour} сағат* қалды!\n───────────────\n\n`;
        }

        if (debtors1.length > 0) {
            for (let uid of debtors1) {
                text += `@${uid.split('@')[0]} `;
            }
            text += "\n";
            if (isSatSpecial) {
                text += `───────────────\n🤲 Сенбілік параларыңызды асықпай Жексенбі кешке дейін оқып, реакция қоюды ұмытпаңыздар!`;
            } else {
                text += `───────────────\n🤲 Алла ризалығы үшін, параларыңызды оқып, таңғы хабарламаға белгі қоюды ұмытпаңыздар!`;
            }
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

        const missed1 = db.users_1.filter(u => !db.today.read_1.includes(u));

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
                if (reads.includes(uid)) { marks += "✅"; presentCount++; }
                else if (db.late_1[d] && db.late_1[d].includes(uid)) { marks += "🟧"; lateCount++; }
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
            if (reads.includes(uid)) presentCount++;
            else if (db.late_1[d] && db.late_1[d].includes(uid)) lateCount++;
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

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const chatId = msg.key.remoteJid;
            const botJid = cleanUserId(sock.user.id);
            const senderId = msg.key.fromMe ? botJid : cleanUserId(msg.key.participant || msg.key.remoteJid);
            const msgId = msg.key.id;

            let actualMessage = msg.message;
            if (actualMessage?.ephemeralMessage) actualMessage = actualMessage.ephemeralMessage.message;
            if (actualMessage?.viewOnceMessageV2) actualMessage = actualMessage.viewOnceMessageV2.message;

            if (actualMessage?.reactionMessage) {
                msg.message = actualMessage;
                const reaction = msg.message.reactionMessage;
                const targetMsgId = reaction.key.id;
                const emoji = reaction.text;

                const validReactions = ['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '❤', '❤️', '✅', '➕'];

                if (targetMsgId === db.regMsgId_1) {
                    if (emoji && validReactions.includes(emoji)) {
                        if (getAlmatyDateStr() === START_DATE) {
                            if (!db.users_1.includes(senderId)) {
                                db.users_1.push(senderId);
                                console.log(`Тіркелді (1-пара): ${senderId}`);
                            }
                        }
                    } else if (!emoji && getAlmatyDateStr() === START_DATE) {
                        db.users_1 = db.users_1.filter(u => u !== senderId);
                    }
                    saveDb();
                    return;
                }

                let isGroup1Task = (db.today.msgId_1 === targetMsgId);
                let isLateTask = false;
                let lateDate = null;

                if (!isGroup1Task) {
                    if (db.pastMsgIds_1 && db.pastMsgIds_1[targetMsgId]) {
                        isLateTask = true;
                        lateDate = db.pastMsgIds_1[targetMsgId];
                    } else {
                        return;
                    }
                }

                const inGroup1 = db.users_1.includes(senderId);

                if (emoji) {
                    if (!validReactions.includes(emoji)) return;
                    if (isLateTask) {
                        if (!inGroup1) return;
                        if (db.history_1[lateDate] && db.history_1[lateDate].includes(senderId)) return;
                        if (!db.late_1[lateDate]) db.late_1[lateDate] = [];
                        if (!db.late_1[lateDate].includes(senderId)) {
                            db.late_1[lateDate].push(senderId);
                            if (db.strikes && db.strikes[senderId] && db.strikes[senderId] > 0) {
                                db.strikes[senderId]--;
                            }
                            console.log(`🟧 Кешігіп оқыды: ${senderId} -> ${lateDate}`);
                        }
                    } else if (isGroup1Task) {
                        if (!inGroup1) return;
                        if (!db.today.read_1.includes(senderId)) db.today.read_1.push(senderId);
                    }
                } else {
                    if (isLateTask) {
                        if (db.late_1[lateDate]) {
                            const idx = db.late_1[lateDate].indexOf(senderId);
                            if (idx > -1) db.late_1[lateDate].splice(idx, 1);
                        }
                    } else {
                        const idx = db.today.read_1.indexOf(senderId);
                        if (idx > -1) db.today.read_1.splice(idx, 1);
                    }
                }
                saveDb();

                if (emoji && !isLateTask) {
                    const validUsers1 = db.users_1.filter(u => u);
                    if (validUsers1.length > 0) {
                        const allRead1 = validUsers1.every(u => db.today.read_1.includes(u));
                        if (allRead1) {
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
                                console.log("Барлығы оқып бітті. Дедлайн ерте жабылды!");
                            } catch (e) {
                                console.error("Ерте дедлайн жабуда қате шықты:", e);
                            }
                        }
                    }
                }
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
                    if (db.users_1.includes(senderId)) {
                        if (db.history_1[taskDate] && db.history_1[taskDate].includes(senderId)) return;
                        if (taskDate === db.today.date && db.today.read_1.includes(senderId)) return;

                        if (!db.late_1[taskDate]) db.late_1[taskDate] = [];
                        if (!db.late_1[taskDate].includes(senderId)) {
                            db.late_1[taskDate].push(senderId);
                            if (db.strikes && db.strikes[senderId] && db.strikes[senderId] > 0) {
                                db.strikes[senderId]--;
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
                    `▫️ *!force_task* — Таңғы тапсырманы қазір мәжбүрлі түрде негізгі топқа жіберу\n` +
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

            if (messageText === '!force_task') {
                reply('⏳ Тапсырма жіберілуде...');
                await sendMorningTask(getAlmatyDateStr());
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
                reply(`📅 Күн: ${db.today.date}\n👥 Оқығандар: ${db.today.read_1.length}/${db.users_1.length}`);
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
                const missed = db.users_1.filter(u => !read.includes(u));
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
