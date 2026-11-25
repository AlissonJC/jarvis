import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedAddress, vetTarget } from '../bridge/net.mjs'

test('L6: addresses that carry a private IPv4 inside an IPv6 one are blocked (NAT64, 6to4, Teredo, compatible)', () => {
  // The reviewer's probe: the first two used to be reported as public.
  for (const a of ['64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:c0a8:101::', '2002:a9fe:a9fe::', '64:ff9b:1::1', '2001::1', '::7f00:1', '::ffff:7f00:1', '100::1', 'fec0::1']) {
    assert.equal(blockedAddress(a), true, a)
  }
  // And public addresses in those same ranges still are.
  for (const a of ['64:ff9b::808:808', '2002:808:808::', '2606:4700::1111', '2a00:1450:4001::200e', '8.8.8.8', '93.184.215.14']) {
    assert.equal(blockedAddress(a), false, a)
  }
})

test('L6: the older rules still hold', () => {
  for (const a of ['127.0.0.1', '0.0.0.0', '::ffff:127.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', '169.254.169.254', '100.64.0.1', '10.0.0.1', '192.168.0.1', '172.16.0.1', '224.0.0.1']) {
    assert.equal(blockedAddress(a), true, a)
  }
})

test('a trailing dot does not hide localhost', () => {
  for (const u of ['http://localhost./', 'http://foo.localhost../', 'http://localhost/', 'http://printer.local./', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/']) {
    assert.throws(() => vetTarget(u), /blocked host/, u)
  }
  assert.doesNotThrow(() => vetTarget('https://example.com./'))
})
