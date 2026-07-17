import assert from 'node:assert/strict'
import test from 'node:test'
import { validateWebRegistration } from '../src/services/webAuthValidation.ts'

test('accepts registration field boundaries and alphaDash accounts', () => {
  assert.deepEqual(validateWebRegistration({
    account: 'qa-user_01',
    nickname: '测试用户',
    password: '12345678',
    passwordConfirm: '12345678',
    code: 'AbCd'
  }), {})

  assert.deepEqual(validateWebRegistration({
    account: `a${'z'.repeat(63)}`,
    nickname: '昵'.repeat(64),
    password: 'p'.repeat(72),
    passwordConfirm: 'p'.repeat(72),
    code: 'Wxyz'
  }), {})
})

test('rejects invalid account, nickname, password, confirmation and captcha', () => {
  const errors = validateWebRegistration({
    account: 'invalid account',
    nickname: '',
    password: 'short',
    passwordConfirm: 'different',
    code: ' '
  })

  assert.deepEqual(Object.keys(errors).sort(), [
    'account',
    'code',
    'nickname',
    'password',
    'passwordConfirm'
  ])
})

test('requires captcha input to contain exactly four characters', () => {
  const validFields = {
    account: 'qa_user',
    nickname: '测试用户',
    password: 'password-123',
    passwordConfirm: 'password-123'
  }

  assert.equal(validateWebRegistration({ ...validFields, code: 'abc' }).code, '图形验证码必须为 4 个字符')
  assert.equal(validateWebRegistration({ ...validFields, code: 'abcde' }).code, '图形验证码必须为 4 个字符')
  assert.equal(validateWebRegistration({ ...validFields, code: 'AbCd' }).code, undefined)
})
