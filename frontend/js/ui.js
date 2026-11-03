function showAlert(element, message, type = 'error') {
  if (!element) return;
  element.className = `alert alert-${type}`;
  element.textContent = message;
  element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearAlert(element) {
  if (!element) return;
  element.className = 'alert';
  element.textContent = '';
}


function setButtonLoading(button, loadingLabel) {
  if (!button) return () => {};

  const originalHtml = button.innerHTML;
  const originalDisabled = button.disabled;

  button.disabled = true;
  button.classList.add('is-loading');
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${loadingLabel}`;

  return function restore() {
    button.disabled = originalDisabled;
    button.classList.remove('is-loading');
    button.innerHTML = originalHtml;
  };
}


function applyFieldErrors(formEl, errors = []) {
  
  formEl.querySelectorAll('.field.has-error').forEach((el) => {
    el.classList.remove('has-error');
  });

  errors.forEach(({ field, message }) => {
    const input = formEl.querySelector(`[name="${field}"]`);
    if (!input) return;
    const wrapper = input.closest('.field');
    if (!wrapper) return;
    wrapper.classList.add('has-error');
    const errorEl = wrapper.querySelector('.field-error');
    if (errorEl) errorEl.textContent = message;
  });
}


function initPasswordToggle(toggleButton, input) {
  if (!toggleButton || !input) return;
  toggleButton.addEventListener('click', () => {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    toggleButton.innerHTML = isHidden
      ? '<i class="fa-solid fa-eye-slash"></i>'
      : '<i class="fa-solid fa-eye"></i>';
    toggleButton.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const passwordToggle = document.getElementById('toggle-password');
  const passwordInput = document.getElementById('password');

  initPasswordToggle(passwordToggle, passwordInput);
});