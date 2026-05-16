const chatGeneration = new Map();

function bumpChatGeneration(chatId) {
  const next = (chatGeneration.get(chatId) || 0) + 1;
  chatGeneration.set(chatId, next);
  return next;
}

function getChatGeneration(chatId) {
  return chatGeneration.get(chatId) || 0;
}

module.exports = { bumpChatGeneration, getChatGeneration };

