import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInterrupt, buildWake, echoesSpoken } from '../src/lib/wake.ts'
import {
  WAKE,
  BARE_NAME,
  LEADING_NAME,
  isSpokenInterrupt,
  isUserInterrupt,
  wakeVariants,
  parseWakeWords,
  NAME_DOTTED,
  CALL_PHRASE,
} from '../src/lib/identity.ts'

test('wakes on the name, with or without a greeting', () => {
  for (const said of [
    'jarvis',
    'Jarvis',
    'ei jarvis',
    'Ei, Jarvis!',
    'hey jarvis',
    'oi jarvis, que horas são',
    'olá Jarvis',
    'ola jarvis',
    'ok jarvis',
    'okay jarvis',
    'Jarvis, abre o calendário',
    'então jarvis me diz uma coisa',
  ]) {
    assert.ok(WAKE.test(said), `deveria acordar: ${said}`)
  }
})

test('wakes on the way a pt-BR recogniser mishears the name', () => {
  for (const said of [
    'jarves',
    'ei jarvas',
    'jarbas',
    'ei jervis',
    'djarvis',
    'jar vis',
    'ei jar vis',
    'jarvys',
    'ei travis',
  ]) {
    assert.ok(WAKE.test(said), `deveria acordar: ${said}`)
  }
})

test('does not wake on look-alike words', () => {
  for (const said of [
    'javali',
    'jardim',
    'jarra de suco',
    'jarro',
    'java script',
    'vamos ao jardim zoológico',
    'o javali correu',
    'marvis',
    'jarvisado',
    "jarvis's job",
    'bom dia',
    'ei você',
    'olá, tudo bem',
    '',
  ]) {
    assert.ok(!WAKE.test(said), `não deveria acordar: "${said}"`)
  }
})

test('afterWake-style slicing: LEADING_NAME strips the vocative, BARE_NAME spots a lone one', () => {
  assert.ok(BARE_NAME.test('ei jarvis'))
  assert.ok(BARE_NAME.test('Jarvis.'))
  assert.ok(BARE_NAME.test('olá, jarvis!'))
  assert.ok(!BARE_NAME.test('jarvis que horas são'))
  assert.equal('Jarvis, que horas são?'.replace(LEADING_NAME, '').trim(), 'que horas são?')
  assert.equal('ei jarves que dia é hoje'.replace(LEADING_NAME, '').trim(), 'que dia é hoje')
  assert.equal('que horas são'.replace(LEADING_NAME, ''), 'que horas são')
})

test('the match index lets the command after the name be sliced off', () => {
  const m = WAKE.exec('ei jarvis qual a previsão do tempo')
  assert.ok(m)
  const rest = 'ei jarvis qual a previsão do tempo'.slice(m.index + m[0].length).trim()
  assert.equal(rest, 'qual a previsão do tempo')
})

test('spoken interrupt: Portuguese', () => {
  for (const said of [
    'pare',
    'para',
    'espera',
    'cancela',
    'cancele isso',
    'chega',
    'silêncio',
    'silencio',
    'cala a boca',
    'já chega',
    'ja chega',
    'espera um pouco',
    'não',
    'jarvis',
    'ei jarves',
  ]) {
    assert.ok(isSpokenInterrupt(said), `deveria interromper: ${said}`)
  }
})

test('spoken interrupt: English ones are kept', () => {
  for (const said of ['stop', 'wait', 'cancel', 'enough', 'quiet', 'hold on', 'shut up', 'never mind', 'forget it', 'no']) {
    assert.ok(isSpokenInterrupt(said), `should interrupt: ${said}`)
  }
})

test('everyday Portuguese words inside a sentence do not interrupt (his own voice must not stop him)', () => {
  for (const said of [
    'o resultado é para você amanhã cedo',
    'estou no centro da cidade agora',
    'não encontrei nenhum registro disso',
    'ele espera uma resposta até sexta',
    'o voo chega às oito e quinze',
    'a capital do Brasil é Brasília',
  ]) {
    assert.ok(!isSpokenInterrupt(said), `não deveria interromper: ${said}`)
  }
  // ...but "cancela" and the like are strong enough to count inside a sentence.
  assert.ok(isSpokenInterrupt('por favor cancela isso agora'))
})

test('buildWake/buildInterrupt work for another name', () => {
  const w = buildWake(['sexta', 'sesta'])
  assert.ok(w.wake.test('ei sexta'))
  assert.ok(w.wake.test('Sexta, que horas são'))
  assert.ok(!w.wake.test('sextas'))
  assert.ok(!w.wake.test('jarvis'))
  const stop = buildInterrupt(['sexta'])
  assert.ok(stop('sexta'))
  assert.ok(stop('pare'))
})

test('buildWake refuses an empty list rather than matching everything', () => {
  assert.throws(() => buildWake([]))
  assert.throws(() => buildWake(['  ']))
})

test('identity: the name is always listened for; extras come from VITE_WAKE_WORDS', () => {
  assert.deepEqual(parseWakeWords(' Sexta, SESTA ,, sêxta '), ['sexta', 'sesta', 'sêxta'])
  assert.deepEqual(parseWakeWords(undefined), [])
  assert.ok(wakeVariants('Jarvis', '').includes('jarves'))
  assert.deepEqual(wakeVariants('Sexta', ''), ['sexta'])
  assert.deepEqual(wakeVariants('Sexta', 'sesta,sexa'), ['sexta', 'sesta', 'sexa'])
  // An explicit list replaces the built-in spellings but never drops the name.
  assert.deepEqual(wakeVariants('Jarvis', 'jarves'), ['jarvis', 'jarves'])
})

test('identity: defaults', () => {
  assert.equal(NAME_DOTTED, 'J.A.R.V.I.S')
  assert.equal(CALL_PHRASE, 'ei jarvis')
})

// -- F2 verifier fixes -------------------------------------------------------

test('possessives of the name do not interrupt, same as they do not wake', () => {
  assert.ok(!isSpokenInterrupt("jarvis's"))
  assert.ok(!isSpokenInterrupt("Jarvis’s job"))
  assert.ok(!WAKE.test("jarvis's"))
  assert.ok(isSpokenInterrupt('jarvis'))
  assert.ok(isSpokenInterrupt('Jarvis!'))
})

test('the bare name interrupts only in a short utterance, or next to a weak word', () => {
  assert.ok(isSpokenInterrupt('jarvis'))
  assert.ok(isSpokenInterrupt('ei jarvis'))
  assert.ok(isSpokenInterrupt('jarvis para'))
  assert.ok(isSpokenInterrupt('Jarvis, para de falar'))
  // His own sentences contain the name; they must not stop him.
  assert.ok(!isSpokenInterrupt('Eu me chamo Jarvis e estou ao seu dispor hoje'))
  assert.ok(!isSpokenInterrupt('O Jarvis encontrou três resultados para o senhor'))
})

test('genuine barge-in still works', () => {
  for (const said of ['pare', 'Pare!', 'Jarvis, pare', 'chega', 'para', 'espera', 'silêncio', 'jarvis']) {
    assert.ok(isUserInterrupt(said, 'Segundo a previsão, amanhã teremos sol e céu aberto na maior parte do dia.'), said)
  }
  // ...also while he is mid-sentence on something unrelated.
  assert.ok(isUserInterrupt('Jarvis, pare', 'A reunião com o time de produto começa às três.'))
})

test('his own words, heard back through the microphone, never interrupt him', () => {
  const cases = [
    ['Não encontrei.', 'Procurei nos três arquivos. Não encontrei. Receio que não haja registro disso.'],
    ['Receio que não.', 'Sobre isso, receio que não haja nada. Posso tentar de outro jeito.'],
    ['Para o senhor.', 'Já deixei tudo pronto, para o senhor revisar.'],
    ['Jarvis', 'Eu sou o Jarvis, ao seu dispor.'],
    // The recogniser mangles one word of long phrases.
    ['Não encontrei registros', 'Procurei e não encontrei registro algum.'],
    // The tail of the previous sentence is part of what he is saying.
    ['Não encontrei', 'Receio que o arquivo esteja vazio. Procurei e não encontrei'],
  ]
  for (const [heard, spoken] of cases) {
    assert.ok(isSpokenInterrupt(heard) , `pré-condição: "${heard}" parece uma interrupção`)
    assert.ok(echoesSpoken(heard, spoken), `deveria ser eco: "${heard}"`)
    assert.ok(!isUserInterrupt(heard, spoken), `não deveria interromper: "${heard}"`)
  }
})

test('echoesSpoken: not fooled by different words, order or a stop word he never said', () => {
  assert.ok(!echoesSpoken('pare', 'Segundo a previsão, amanhã teremos sol.'))
  assert.ok(!echoesSpoken('não encontrei', 'encontrei não o arquivo'))
  assert.ok(!echoesSpoken('jarvis', ''))
  assert.ok(!echoesSpoken('', 'qualquer coisa'))
  // Accents and case do not matter.
  assert.ok(echoesSpoken('NAO ENCONTREI', 'não encontrei nada'))
})

test('echoesSpoken tolerates one missing word in a long phrase', () => {
  assert.ok(echoesSpoken('Receio que não haja registros disso aqui', 'Receio que não haja nenhum registro disso aqui hoje.') === false)
  assert.ok(echoesSpoken('Receio que não haja registros disso', 'Receio que não haja registro disso por aqui.'))
})
