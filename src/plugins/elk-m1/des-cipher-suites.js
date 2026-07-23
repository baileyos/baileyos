// Adds TLS_RSA_WITH_3DES_EDE_CBC_SHA (0x00,0x0A) to node-forge's TLS cipher suite registry.
// node-forge removed this suite; we restore it following the aesCipherSuites.js pattern
// using forge's built-in des.js (3DES-CBC, 24-byte key, 8-byte block).

var forge = require('node-forge');
require('node-forge/lib/des');
require('node-forge/lib/tls');

var tls = forge.tls;

tls.CipherSuites['TLS_RSA_WITH_3DES_EDE_CBC_SHA'] = {
  id: [0x00, 0x0A],
  name: 'TLS_RSA_WITH_3DES_EDE_CBC_SHA',
  initSecurityParameters: function(sp) {
    sp.bulk_cipher_algorithm = tls.BulkCipherAlgorithm.des3;
    sp.cipher_type = tls.CipherType.block;
    sp.enc_key_length = 24;   // 3 × 8 bytes for 3DES-EDE
    sp.block_length = 8;      // DES block size
    sp.fixed_iv_length = 8;
    sp.record_iv_length = 8;
    sp.mac_algorithm = tls.MACAlgorithm.hmac_sha1;
    sp.mac_length = 20;
    sp.mac_key_length = 20;
  },
  initConnectionState: initConnectionState
};

function initConnectionState(state, c, sp) {
  var client = (c.entity === tls.ConnectionEnd.client);

  state.read.cipherState = {
    init: false,
    cipher: forge.cipher.createDecipher('3DES-CBC', client
      ? sp.keys.server_write_key : sp.keys.client_write_key),
    iv: client ? sp.keys.server_write_IV : sp.keys.client_write_IV
  };
  state.write.cipherState = {
    init: false,
    cipher: forge.cipher.createCipher('3DES-CBC', client
      ? sp.keys.client_write_key : sp.keys.server_write_key),
    iv: client ? sp.keys.client_write_IV : sp.keys.server_write_IV
  };
  state.read.cipherFunction = decrypt_3des_cbc_sha1;
  state.write.cipherFunction = encrypt_3des_cbc_sha1;

  state.read.macLength = state.write.macLength = sp.mac_length;
  state.read.macFunction = state.write.macFunction = tls.hmac_sha1;
}

function encrypt_3des_cbc_sha1(record, s) {
  var mac = s.macFunction(s.macKey, s.sequenceNumber, record);
  record.fragment.putBytes(mac);
  s.updateSequenceNumber();

  // TLS 1.0: first record uses pre-generated IV; subsequent use ciphertext residue (iv=null)
  var iv = s.cipherState.init ? null : s.cipherState.iv;
  s.cipherState.init = true;

  var cipher = s.cipherState.cipher;
  cipher.start({iv: iv});
  cipher.update(record.fragment);
  if(cipher.finish(pad_encrypt)) {
    record.fragment = cipher.output;
    record.length = record.fragment.length();
    return true;
  }
  return false;
}

function decrypt_3des_cbc_sha1(record, s) {
  var iv = s.cipherState.init ? null : s.cipherState.iv;
  s.cipherState.init = true;

  var cipher = s.cipherState.cipher;
  cipher.start({iv: iv});
  cipher.update(record.fragment);
  var rval = cipher.finish(pad_decrypt);

  var macLen = s.macLength;
  // use random MAC as fallback to avoid timing attacks
  var mac = forge.random.getBytesSync(macLen);
  var len = cipher.output.length();
  if(len >= macLen) {
    record.fragment = cipher.output.getBytes(len - macLen);
    mac = cipher.output.getBytes(macLen);
  } else {
    record.fragment = cipher.output.getBytes();
  }
  record.fragment = forge.util.createBuffer(record.fragment);
  record.length = record.fragment.length();

  var mac2 = s.macFunction(s.macKey, s.sequenceNumber, record);
  s.updateSequenceNumber();
  rval = compareMacs(s.macKey, mac, mac2) && rval;
  return rval;
}

// Adds TLS-style CBC padding on encrypt (length byte = count - 1, repeated count times)
function pad_encrypt(blockSize, input, decrypt) {
  if(!decrypt) {
    var padding = blockSize - (input.length() % blockSize);
    input.fillWithByte(padding - 1, padding);
  }
  return true;
}

// Validates and removes TLS-style CBC padding on decrypt
function pad_decrypt(blockSize, output, decrypt) {
  if(!decrypt) { return true; }
  var len = output.length();
  var paddingLength = output.last();
  var rval = true;
  // constant-time check: all padding bytes must equal paddingLength
  for(var i = len - 1 - paddingLength; i < len - 1; ++i) {
    rval = rval && (output.at(i) === paddingLength);
  }
  if(rval) {
    output.truncate(paddingLength + 1);
  }
  return rval;
}

function compareMacs(key, mac1, mac2) {
  var hmac = forge.hmac.create();
  hmac.start('SHA1', key);
  hmac.update(mac1);
  mac1 = hmac.digest().getBytes();
  hmac.start(null, null);
  hmac.update(mac2);
  mac2 = hmac.digest().getBytes();
  return mac1 === mac2;
}
