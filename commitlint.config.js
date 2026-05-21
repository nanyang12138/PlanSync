module.exports = {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message) => /^merge master into [a-z0-9][a-z0-9 _/-]*$/.test(message.split(/\r?\n/, 1)[0]),
  ],
};
