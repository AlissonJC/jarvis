import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCALE, langFit, parseLocale } from '../src/lib/locale.ts'

test('parseLocale defaults to pt-BR and normalises', () => {
  assert.deepEqual(parseLocale(undefined), { tag: 'pt-BR', lang: 'pt' })
  assert.deepEqual(parseLocale(''), { tag: 'pt-BR', lang: 'pt' })
  assert.deepEqual(parseLocale('garbage!!'), { tag: 'pt-BR', lang: 'pt' })
  assert.deepEqual(parseLocale('pt_br'), { tag: 'pt-BR', lang: 'pt' })
  assert.deepEqual(parseLocale(' EN-gb '), { tag: 'en-GB', lang: 'en' })
  assert.deepEqual(parseLocale('es'), { tag: 'es', lang: 'es' })
  assert.deepEqual(LOCALE, { tag: 'pt-BR', lang: 'pt' })
})

test('langFit ranks pt-BR above pt-PT above everything else', () => {
  assert.equal(langFit('pt-BR'), 2)
  assert.equal(langFit('pt_BR'), 2)
  assert.equal(langFit('PT-br'), 2)
  assert.equal(langFit('pt-PT'), 1)
  assert.equal(langFit('pt'), 1)
  assert.equal(langFit('en-GB'), 0)
  assert.equal(langFit('es-ES'), 0)
  assert.equal(langFit('pta-XX'), 0)
})

test('langFit follows the configured locale', () => {
  const en = parseLocale('en-GB')
  assert.equal(langFit('en-GB', en), 2)
  assert.equal(langFit('en-US', en), 1)
  assert.equal(langFit('pt-BR', en), 0)
})
