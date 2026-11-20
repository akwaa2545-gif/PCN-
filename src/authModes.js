const AUTH_MODES = Object.freeze(['password', 'employee-code', 'employee-password']);
const isEmployeeMode = mode => mode === 'employee-code' || mode === 'employee-password';

module.exports = { AUTH_MODES, isEmployeeMode };
