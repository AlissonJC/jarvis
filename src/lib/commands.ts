/**
 * Spoken commands that are about the conversation itself, not about the world.
 * Pure, so `node --test` can exercise it (test/security-review3.test.mjs).
 *
 * "Nova conversa" starts a fresh agent session on the bridge: what was said and
 * read so far is forgotten, and so is the taint a read of private data leaves on
 * a session (docs/SEGURANCA.md, O1). It must come from the person, so it is
 * recognised here, in the face, in the transcript of their voice, and only as
 * the WHOLE utterance: a sentence that merely mentions a new conversation, or a
 * page that says the words, is not the command. No tool of the model can reach
 * this function; it sees no model text.
 */
import { LEADING_NAME } from './identity.ts'

const plain = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const PREFIX = '(?:(?:por favor|agora|vamos|pode|pode ser|quero|senhor|ok|entao)\\s+)*'
const SUFFIX = '(?:\\s+(?:por favor|senhor|agora|de novo))*'
const BODY = [
  '(?:(?:comecar|comece|iniciar|inicie|abrir|abra|fazer|faca|criar|crie)\\s+)?(?:uma\\s+)?nova conversa',
  '(?:comecar|comece|iniciar|inicie|abrir|abra|criar|crie)\\s+(?:uma\\s+)?conversa nova',
  '(?:reiniciar|reinicie|recomecar|recomece|zerar|zere|esquecer|esqueca|limpar|limpe)\\s+(?:a|essa|esta)\\s+conversa',
]
const NEW_CONVERSATION = new RegExp(`^${PREFIX}(?:${BODY.join('|')})${SUFFIX}$`)

/** Is the whole of what was said a request to start a new conversation? */
export function isNewConversation(said: string): boolean {
  const text = plain(String(said ?? '').replace(LEADING_NAME, ''))
  return text.length > 0 && text.length <= 60 && NEW_CONVERSATION.test(text)
}
