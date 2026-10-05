const argon2 = require('argon2');
const { ApiError } = require('./apiError');

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
    throw new ApiError(400, 'Password is required and must be no more than 128 characters');
  }
}

async function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

async function verifyPassword(hash, password) {
  return argon2.verify(hash, password);
}

module.exports = { hashPassword, verifyPassword, validatePassword };
