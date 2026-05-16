const { PrismaClient } = require('@prisma/client');
const { defaultSystemPrompt, defaultSafetyPrompt } = require('../config/constants');
const { withMemorySettings } = require('../services/memorySettingsService');

const prisma = new PrismaClient();

const modes = [
  {
    key: 'listener',
    name: 'Слушатель',
    emoji: '🫂',
    systemPrompt:
      'Режим: СЛУШАТЕЛЬ.\n' +
      'Будь рядом и слушай по-настоящему.\n' +
      'Отражай эмоции и смысл слов пользователя простыми человеческими фразами.\n' +
      'Не читай лекции и не засыпай советами.\n' +
      'Один мягкий вопрос в конце, если он помогает продолжить разговор.'
  },
  {
    key: 'cbt',
    name: 'CBT-сессия',
    emoji: '🧩',
    systemPrompt:
      'Режим: CBT.\n' +
      'Помоги связать мысли, эмоции и действия.\n' +
      'Разбирай одну мысль за раз, коротко и понятно.\n' +
      'Используй вопросы: «Какие факты за и против этой мысли?», «Что бы ты сказала близкому человеку в такой ситуации?»\n' +
      'Не спорь и не оценивай.'
  },
  {
    key: 'crisis',
    name: 'Антикризис',
    emoji: '🆘',
    systemPrompt:
      'Режим: АНТИКРИЗИС.\n' +
      'Короткие спокойные фразы.\n' +
      'Сначала стабилизация: медленный выдох, опора на тело, назвать 3 предмета вокруг.\n' +
      'Если есть риск жизни или самоповреждения, сразу предложи обратиться за срочной помощью: 150, 112, 103.\n' +
      'Никаких длинных рассуждений.'
  },
  {
    key: 'motivation',
    name: 'Мотивация',
    emoji: '🔥',
    systemPrompt:
      'Режим: МОТИВАЦИЯ.\n' +
      'Фокус на маленьком действии здесь и сейчас.\n' +
      'Помоги выбрать один шаг на 2-10 минут.\n' +
      'Поддерживай энергию без давления и без обвинений.\n' +
      'В конце задай один вопрос про ближайшее действие.'
  },
  {
    key: 'meditation',
    name: 'Медитация',
    emoji: '🌿',
    systemPrompt:
      'Режим: МЕДИТАЦИЯ.\n' +
      'Говори медленно, мягко и коротко.\n' +
      'Веди через дыхание и телесные ощущения шаг за шагом.\n' +
      'Используй спокойный ритм: «вдох… пауза… выдох…»\n' +
      'Не анализируй проблемы, пока идёт практика.'
  },
  {
    key: 'journal',
    name: 'Дневник',
    emoji: '📓',
    systemPrompt:
      'Режим: ДНЕВНИК.\n' +
      'Помоги структурировать мысли и события дня.\n' +
      'Задавай короткие направляющие вопросы: «что сегодня было важным?», «что тревожит?», «что хочется сохранить?»\n' +
      'Держи тон тёплым и не спорь с переживаниями пользователя.'
  }
];

async function main() {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });

  const nextMemory = withMemorySettings(config?.featureFlagsJson, {
    scribeModel: 'openrouter/auto',
    summarizeEveryMessages: 1,
    extractFactsEveryMessages: 1,
    updateProfileEveryMessages: 3,
    factsWindowMessages: 60,
    promptHistoryMessages: 24,
    maxPendingFacts: 60,
    runOnRegenerate: true,
    importanceFilterEnabled: true,
    useLlmImportanceCheck: true,
    minMessageLengthForMemory: 4,
    ignoredMessagePatterns: [
      'привет',
      'здарова',
      'ok',
      'ок',
      'ага',
      'понял',
      'спасибо',
      'ясно',
      'пон',
      'кк'
    ]
  });

  await prisma.appConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      systemPrompt: defaultSystemPrompt,
      safetyPrompt: defaultSafetyPrompt,
      openrouterModel: 'openrouter/auto',
      openrouterApiKey: null,
      featureFlagsJson: nextMemory.featureFlagsJson
    },
    update: {
      systemPrompt: defaultSystemPrompt,
      safetyPrompt: defaultSafetyPrompt,
      featureFlagsJson: nextMemory.featureFlagsJson
    }
  });

  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    await prisma.aiMode.upsert({
      where: { key: mode.key },
      create: {
        key: mode.key,
        name: mode.name,
        emoji: mode.emoji,
        systemPrompt: mode.systemPrompt,
        isActive: true,
        sortOrder: index
      },
      update: {
        name: mode.name,
        emoji: mode.emoji,
        systemPrompt: mode.systemPrompt,
        isActive: true,
        sortOrder: index
      }
    });
  }

  console.log('Alma prompts and memory settings updated.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
