export interface WebRegistrationFields {
  account: string
  nickname: string
  password: string
  passwordConfirm: string
  code: string
}

export type WebRegistrationField = keyof WebRegistrationFields
export type WebRegistrationErrors = Partial<Record<WebRegistrationField, string>>

const characterLength = (value: string) => Array.from(value).length

export function validateWebRegistration(fields: WebRegistrationFields): WebRegistrationErrors {
  const errors: WebRegistrationErrors = {}
  const account = fields.account.trim()
  const nickname = fields.nickname.trim()

  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(account)) {
    errors.account = '账号需为 2-64 位字母、数字、下划线或连字符'
  }
  if (characterLength(nickname) < 1 || characterLength(nickname) > 64) {
    errors.nickname = '昵称需为 1-64 个字符'
  }
  if (characterLength(fields.password) < 8 || characterLength(fields.password) > 72) {
    errors.password = '密码需为 8-72 个字符'
  }
  if (fields.passwordConfirm !== fields.password) {
    errors.passwordConfirm = '两次输入的密码不一致'
  }
  if (characterLength(fields.code.trim()) !== 4) {
    errors.code = '图形验证码必须为 4 个字符'
  }

  return errors
}
