'use strict'

const protobuf = require('protocol-buffers')
const PeerId = require('peer-id')
const crypto = require('libp2p-crypto')
const parallel = require('async/parallel')
const waterfall = require('async/waterfall')
const debug = require('debug')
const log = debug('libp2p:secio')
log.error = debug('libp2p:secio:error')

const pbm = protobuf(require('./secio.proto'))

const support = require('../support')

// nonceSize is the size of our nonces (in bytes)
const nonceSize = 16

exports.createProposal = (state) => {
  state.proposal.out = {
    rand: support.randomBytes(nonceSize),
    pubkey: state.key.local.public.bytes,
    exchanges: support.exchanges.join(','),
    ciphers: support.ciphers.join(','),
    hashes: support.hashes.join(',')
  }

  state.proposalEncoded.out = pbm.Propose.encode(state.proposal.out)
  return state.proposalEncoded.out
}

exports.createExchange = (state, callback) => {
  crypto.generateEphemeralKeyPair(state.protocols.local.curveT, (err, res) => {
    if (err) {
      return callback(err)
    }

    state.ephemeralKey.local = res.key
    state.shared.generate = res.genSharedKey

    // Gather corpus to sign.
    const selectionOut = Buffer.concat([
      state.proposalEncoded.out,
      state.proposalEncoded.in,
      state.ephemeralKey.local
    ])

    state.key.local.sign(selectionOut, (err, sig) => {
      if (err) {
        return callback(err)
      }

      state.exchange.out = {
        epubkey: state.ephemeralKey.local,
        signature: sig
      }

      callback(null, pbm.Exchange.encode(state.exchange.out))
    })
  })
}

exports.identify = (state, msg, callback) => {
  log('1.1 identify')

  state.proposalEncoded.in = msg
  state.proposal.in = pbm.Propose.decode(msg)
  const pubkey = state.proposal.in.pubkey

  state.key.remote = crypto.unmarshalPublicKey(pubkey)
  PeerId.createFromPubKey(pubkey.toString('base64'), (err, remoteId) => {
    if (err) {
      return callback(err)
    }

    state.id.remote = remoteId

    log('1.1 identify - %s - identified remote peer as %s', state.id.local.toB58String(), state.id.remote.toB58String())
    callback()
  })
}

exports.selectProtocols = (state, callback) => {
  log('1.2 selection')

  const local = {
    pubKeyBytes: state.key.local.public.bytes,
    exchanges: support.exchanges,
    hashes: support.hashes,
    ciphers: support.ciphers,
    nonce: state.proposal.out.rand
  }

  const remote = {
    pubKeyBytes: state.proposal.in.pubkey,
    exchanges: state.proposal.in.exchanges.split(','),
    hashes: state.proposal.in.hashes.split(','),
    ciphers: state.proposal.in.ciphers.split(','),
    nonce: state.proposal.in.rand
  }

  support.selectBest(local, remote, (err, selected) => {
    if (err) {
      return callback(err)
    }
    // we use the same params for both directions (must choose same curve)
    // WARNING: if they dont SelectBest the same way, this won't work...
    state.protocols.remote = {
      order: selected.order,
      curveT: selected.curveT,
      cipherT: selected.cipherT,
      hashT: selected.hashT
    }

    state.protocols.local = {
      order: selected.order,
      curveT: selected.curveT,
      cipherT: selected.cipherT,
      hashT: selected.hashT
    }
    callback()
  })
}

exports.verify = (state, msg, callback) => {
  log('2.1. verify')

  state.exchange.in = pbm.Exchange.decode(msg)
  state.ephemeralKey.remote = state.exchange.in.epubkey

  const selectionIn = Buffer.concat([
    state.proposalEncoded.in,
    state.proposalEncoded.out,
    state.ephemeralKey.remote
  ])

  state.key.remote.verify(selectionIn, state.exchange.in.signature, (err, sigOk) => {
    if (err) {
      return callback(err)
    }

    if (!sigOk) {
      return callback(new Error('Bad signature'))
    }

    log('2.1. verify - signature verified')
    callback()
  })
}

exports.generateKeys = (state, callback) => {
  log('2.2. keys')

  waterfall([
    (cb) => state.shared.generate(state.exchange.in.epubkey, cb),
    (secret, cb) => {
      state.shared.secret = secret

      crypto.keyStretcher(
        state.protocols.local.cipherT,
        state.protocols.local.hashT,
        state.shared.secret,
        cb
      )
    },
    (keys, cb) => {
      // use random nonces to decide order.
      if (state.protocols.local.order > 0) {
        state.protocols.local.keys = keys.k1
        state.protocols.remote.keys = keys.k2
      } else if (state.protocols.local.order < 0) {
        // swap
        state.protocols.local.keys = keys.k2
        state.protocols.remote.keys = keys.k1
      } else {
        // we should've bailed before state. but if not, bail here.
        return cb(new Error('you are trying to talk to yourself'))
      }

      log('2.3. mac + cipher')

      parallel([
        (cb) => support.makeMacAndCipher(state.protocols.local, cb),
        (cb) => support.makeMacAndCipher(state.protocols.remote, cb)
      ], cb)
    }
  ], callback)
}

exports.verifyNonce = (state, n2) => {
  const n1 = state.proposal.out.rand

  if (n1.equals(n2)) return

  throw new Error(
    `Failed to read our encrypted nonce: ${n1.toString('hex')} != ${n2.toString('hex')}`
  )
}
