import { Telegraf } from 'telegraf';
import { getMessage } from './messages';
import { saveMessage, updateMessageResponse, getUserResponseStats, getLastBotMessage, getLastNBotMessages, addUser } from './db';
import fs from 'fs';
import path from 'path';
import { CalendarService } from './calendar';
import { generateMessage } from './llm';
import { readFileSync } from 'fs';

const HOURS = 60 * 60 * 1000;

// Функция экранирования для HTML (Telegram)
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

if (!fs.existsSync('assets/current_image_index.txt')) {
  fs.writeFileSync('assets/current_image_index.txt', '0');
}

export class Scheduler {
  private bot: Telegraf;
  private reminderTimeouts: Map<number, NodeJS.Timeout> = new Map();
  private users: Set<number> = new Set();
  private currentImageIndex: number = parseInt(readFileSync('assets/current_image_index.txt', 'utf-8')) || 0;
  private imageFiles: string[] = [];
  public readonly CHANNEL_ID = -1002405993986;
  private readonly REMINDER_USER_ID = 5153477378;
  private calendarService: CalendarService;

  constructor(bot: Telegraf, calendarService: CalendarService) {
    this.bot = bot;
    this.calendarService = calendarService;
    this.loadImages();
  }

  // Загрузить список картинок при старте
  private loadImages() {
    const imagesDir = path.join(process.cwd(), 'images');
    const files = fs.readdirSync(imagesDir);
    this.imageFiles = files
      .filter(file =>
        file.toLowerCase().endsWith('.jpg') ||
        file.toLowerCase().endsWith('.jpeg') ||
        file.toLowerCase().endsWith('.png')
      )
      .map(file => path.join(imagesDir, file));

    console.log('📸 Загружено картинок:', this.imageFiles.length);
    console.log('📸 Список картинок:', this.imageFiles);
  }

  // Получить следующую картинку по кругу
  public getNextImage(): string {
    const image = this.imageFiles[this.currentImageIndex];
    console.log('🔄 Текущий индекс картинки:', this.currentImageIndex);
    console.log('🖼️ Выбрана картинка:', image);

    this.currentImageIndex = (this.currentImageIndex + 1) % this.imageFiles.length;
    fs.writeFileSync('assets/current_image_index.txt', this.currentImageIndex.toString());
    return image;
  }

  // Добавить пользователя в список рассылки
  addUser(chatId: number) {
    this.users.add(chatId);
  }

  // Вспомогательная функция для проверки перелёта/аэропорта в событиях
  private hasFlightEvent(events: any[]): boolean {
    return events.some(e => /перел[её]т|аэропорт|flight|airport/i.test(e.summary || ''));
  }

  // Вспомогательная функция для формирования сообщения по правилам
  private buildScheduledMessageFromHF(json: any): string {
    let n = 1;
    const parts: string[] = [];
    // Вдохновляющий текст
    parts.push(`<i>${escapeHTML(json.encouragement.text)}</i>`);

    // 1. Выгрузка неприятных переживаний (рандомно)
    const showNegative = Math.random() < 0.5;
    if (showNegative) {
      let block = `${n++}. <b>Выгрузка неприятных переживаний</b>`;
      if (json.negative_part?.additional_text) {
        block += `\n<blockquote>${escapeHTML(json.negative_part.additional_text)}</blockquote>`;
      }
      parts.push(block);
    }

    // 2. Плюшки для лягушки (без пустой строки перед этим пунктом)
    let plushki = `${n++}. <b>Плюшки для лягушки</b>`;
    if (json.positive_part?.additional_text) {
      plushki += `\n<blockquote>${escapeHTML(json.positive_part.additional_text)}</blockquote>`;
    }
    parts.push(plushki);

    // 3. Чувства и эмоции
    let feels = `${n++}. Какие <b>чувства</b> и <b>эмоции</b> сегодня испытывал?`;
    if (json.feels_and_emotions?.additional_text) {
      feels += `\n<blockquote>${escapeHTML(json.feels_and_emotions.additional_text)}</blockquote>`;
    }
    parts.push(feels);

    // 4. Рейтинг дня
    parts.push(`${n++}. <b>Рейтинг дня</b>: от 1 до 10`);

    // 5. Расслабление тела или Дыхательная практика (рандомно)
    if (Math.random() < 0.5) {
      parts.push(`${n++}. <b>Расслабление тела</b>\nОт Ирины 👉🏻 clck.ru/3LmcNv 👈🏻 или свое`);
    } else {
      parts.push(`${n++}. <b>Дыхательная практика</b>`);
    }

    return parts.filter(Boolean).join('\n\n').trim();
  }

  // Основная функция генерации сообщения для 19:30
  public async generateScheduledMessage(chatId: number): Promise<string> {

    const userExists = await this.checkUserExists(chatId);
    if (!userExists) {
      console.log(`👤 Пользователь ${chatId} не найден в базе. Добавляю...`);
      addUser(chatId, '');
    }


    // Получаем события на вечер
    const now = new Date();
    const evening = new Date(now);
    evening.setHours(18, 0, 0, 0);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const events = await this.calendarService.getEvents(evening.toISOString(), tomorrow.toISOString());
    console.log('🗓️ События календаря на вечер:', events);
    const dateTimeStr = now.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    let previousMessagesBlock = '';

    const lastMsgs = getLastNBotMessages(chatId, 3);
    if (lastMsgs && lastMsgs.length > 0) {
      // Сообщения идут от новых к старым, надо развернуть для хронологии
      const ordered = lastMsgs.slice().reverse();
      previousMessagesBlock = '\n\nПоследние сообщения пользователю:' + ordered.map((m, i) => `\n${i + 1}. ${m.message_text}`).join('');
      console.log('🔄 Последние сообщения пользователю:', previousMessagesBlock);
    } else {
      console.log('🔄 Не приложились последние сообщения пользователя', chatId, lastMsgs);
    }

    let promptBase = readFileSync('assets/prompts/scheduled-message.md', 'utf-8');
    // Формируем строку событий с датой и временем
    let eventsStr = '';
    if (events && events.length > 0) {
      eventsStr = '\nСобытия календаря:' + events.map((e: any) => {
        const start = e.start?.dateTime || e.start?.date;
        let timeStr = '';
        if (start) {
          const d = new Date(start);
          timeStr = d.toLocaleString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
        return `\n• ${e.summary}${timeStr ? ` (${timeStr})` : ''}`;
      }).join('');
    }
    let prompt = promptBase +
      `\n\nСегодня: ${dateTimeStr}.` +
      eventsStr +
      previousMessagesBlock;
    if (this.hasFlightEvent(events || [])) {
      // Если есть перелёт — полностью генерируем текст через HF, ограничиваем 555 символами
      prompt += '\nСегодня у пользователя перелёт или аэропорт.';
      let text = await generateMessage(prompt);
      if (text.length > 555) text = text.slice(0, 552) + '...';
      return text;
    } else {
      // Обычный день — используем структуру с пунктами

      let jsonText = await generateMessage(prompt);
      if (jsonText === 'HF_JSON_ERROR') {
        const fallback = readFileSync('assets/fallback_text', 'utf-8');
        return fallback;
      }
      // Пост-обработка: убираем markdown-блоки и экранирование
      jsonText = jsonText.replace(/```json|```/gi, '').trim();
      // Если строка начинается и заканчивается кавычками, убираем их
      if (jsonText.startsWith('"') && jsonText.endsWith('"')) {
        jsonText = jsonText.slice(1, -1);
      }
      // Заменяем экранированные кавычки
      jsonText = jsonText.replace(/\\"/g, '"').replace(/\"/g, '"');
      let json: any;
      try {
        json = JSON.parse(jsonText);
        if (typeof json === 'string') {
          json = JSON.parse(json); // второй парс, если строка
        }
        // Проверяем, что структура валидная
        if (!json || typeof json !== 'object' || !json.encouragement || !json.negative_part || !json.positive_part || !("feels_and_emotions" in json)) {
          throw new Error('Invalid structure');
        }
      } catch {
        // fallback всегда
        const fallback = readFileSync('assets/fallback_text', 'utf-8');
        return fallback;
      }
      let message = this.buildScheduledMessageFromHF(json);

      console.log(`💾 Сохраняю сообщение в базу для chatId=${chatId}...`);
      saveMessage(chatId, message, new Date().toISOString());
      console.log('💾 Сообщение сохранено!');

      return message;
    }
  }

  // Отправить сообщение в канал
  async sendDailyMessage(chatId: number) {
    try {
      console.log('📤 Начинаю отправку сообщения в канал');
      console.log('�� ID канала:', this.CHANNEL_ID);
      // Проверяем, есть ли пользователь в базе
      const userExists = await this.checkUserExists(chatId);
      if (!userExists) {
        console.log(`👤 Пользователь ${chatId} не найден в базе. Добавляю...`);
        addUser(chatId, '');
      }
      // Показываем, что бот "пишет" (реакция)
      await this.bot.telegram.sendChatAction(this.CHANNEL_ID, 'upload_photo');
      const message = await this.generateScheduledMessage(chatId);
      console.log('📤 Текст сообщения:', message);
      const imagePath = this.getNextImage();
      console.log('📤 Путь к картинке:', imagePath);
      const caption = message.length > 1024 ? message.slice(0, 1020) + '...' : message;
      // Отправляем фото с подписью
      await this.bot.telegram.sendPhoto(this.CHANNEL_ID, { source: imagePath }, {
        caption,
        parse_mode: 'HTML'
      });
      // Если текст был обрезан — отправляем полный текст отдельным сообщением
      if (message.length > 1024) {
        await this.bot.telegram.sendMessage(this.CHANNEL_ID, message, { parse_mode: 'HTML' });
      }
      console.log('✅ Сообщение успешно отправлено в канал');
      // Сохраняем время отправки
      const sentTime = new Date().toISOString();
      console.log(`💾 Сохраняю сообщение в базу для chatId=${chatId}...`);
      saveMessage(chatId, message, sentTime);
      console.log('💾 Сообщение сохранено!');
      // Устанавливаем напоминание через 1.5 часа
      this.setReminder(chatId, sentTime);
    } catch (error) {
      console.error('❌ Ошибка при отправке сообщения:', error);
      console.error('❌ Детали ошибки:', JSON.stringify(error, null, 2));
    }
  }

  // Проверка наличия пользователя в базе
  private async checkUserExists(chatId: number): Promise<boolean> {
    const { db } = await import('./db');
    const row = db.query('SELECT 1 FROM users WHERE chat_id = ?').get(chatId);
    return !!row;
  }

  // Установить напоминание с учётом календаря и генерацией креативного текста
  async setReminder(chatId: number, sentBotMsgTime: string) {
    const timeout = setTimeout(async () => {
      const stats = getUserResponseStats(chatId);
      if (!stats || !stats.last_response_time || new Date(stats.last_response_time) < new Date(sentBotMsgTime)) {
        // Получаем события за неделю назад и день вперёд
        const now = new Date();
        const weekAgo = new Date(now);
        weekAgo.setDate(now.getDate() - 7);
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        const events = await this.calendarService.getEvents(
          weekAgo.toISOString(),
          tomorrow.toISOString()
        );
        // Фильтруем только эмоционально заряженные события (например, по ключевым словам)
        const importantEvents = (events || []).filter((event: any) => {
          const summary = (event.summary || '').toLowerCase();
          // Пример фильтрации: пропускаем события без описания или с нейтральными словами
          const neutralWords = ['напоминание', 'дело', 'встреча', 'meeting', 'call', 'appointment'];
          if (!summary) return false;
          return !neutralWords.some(word => summary.includes(word));
        });
        // Формируем промпт для генерации напоминания
        let prompt = 'Составь креативное, дружелюбное напоминание для пользователя, учитывая его недавние важные события:\n';
        if (importantEvents.length > 0) {
          prompt += 'Вот список событий:\n';
          prompt += importantEvents.map((event: any) => {
            const start = event.start.dateTime || event.start.date;
            const time = event.start.dateTime
              ? new Date(event.start.dateTime).toLocaleString()
              : 'Весь день';
            return `• ${event.summary} (${time})`;
          }).join('\n');
        } else {
          prompt += 'Нет ярко выраженных событий за последнюю неделю.';
        }
        prompt += '\nПожелай хорошего дня и мягко напомни ответить на сообщение.';
        // Генерируем текст напоминания
        const reminderText = await generateMessage(prompt);
        await this.bot.telegram.sendMessage(
          this.REMINDER_USER_ID,
          reminderText
        );
      }
    }, 1.5 * 60 * 60 * 1000); // 1.5 часа

    this.reminderTimeouts.set(chatId, timeout);
  }

  // Запустить ежедневную рассылку
  startDailySchedule() {
    // Устанавливаем время отправки (19:30)
    const scheduleTime = new Date();
    scheduleTime.setHours(19, 30, 0, 0);

    // Если текущее время больше 19:30, планируем на следующий день
    if (new Date() > scheduleTime) {
      scheduleTime.setDate(scheduleTime.getDate() + 1);
    }

    // Вычисляем задержку до следующей отправки
    const delay = scheduleTime.getTime() - new Date().getTime();

    // Планируем отправку
    setTimeout(() => {
      // Отправляем сообщения всем пользователям
      this.users.forEach(chatId => this.sendDailyMessage(chatId));
      // Планируем следующую отправку через 24 часа
      setInterval(() => {
        this.users.forEach(chatId => this.sendDailyMessage(chatId));
      }, 24 * 60 * 60 * 1000);
    }, delay);
  }

  // Очистить напоминание
  clearReminder(chatId: number) {
    const timeout = this.reminderTimeouts.get(chatId);
    if (timeout) {
      clearTimeout(timeout);
      this.reminderTimeouts.delete(chatId);
    }
  }

  // Добавить разовую отправку сообщения
  scheduleOneTimeMessage(chatId: number, targetTime: Date) {
    const now = new Date();
    const delay = targetTime.getTime() - now.getTime();

    if (delay > 0) {
      setTimeout(() => {
        this.sendDailyMessage(chatId);
      }, delay);
    }
  }
} 