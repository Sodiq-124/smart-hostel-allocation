

document.addEventListener('DOMContentLoaded', () => {
  wireRegisterForm();
  wireLoginForm();
  wireAdminLoginForm();
});


function wireRegisterForm() {
  const form = document.getElementById('register-form');
  if (!form) return;

  const alertBox = document.getElementById('form-alert');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    const payload = {
      full_name: form.full_name.value.trim(),
      student_id: form.student_id.value.trim(),
      email: form.email.value.trim(),
      gender: form.gender.value,
      password: form.password.value,
      confirm_password: form.confirm_password.value,
    };

    
    
    
    if (payload.password !== payload.confirm_password) {
      applyFieldErrors(form, [{ field: 'confirm_password', message: 'Passwords do not match.' }]);
      showAlert(alertBox, 'Passwords do not match.', 'error');
      return;
    }

    const restore = setButtonLoading(submitBtn, 'Creating account…');
    try {
      await api.post('/auth/register', payload);
      showAlert(
        alertBox,
        'Registration successful. Redirecting you to login…',
        'success'
      );
      form.reset();
      setTimeout(() => { window.location.href = '/login.html'; }, 1200);
    } catch (error) {
      if (error.errors && error.errors.length) {
        applyFieldErrors(form, error.errors);
      }
      showAlert(alertBox, error.message, 'error');
    } finally {
      restore();
    }
  });
}


function wireLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) return;

  const alertBox = document.getElementById('form-alert');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    const payload = {
      email: form.email.value.trim(),
      password: form.password.value,
    };

    const restore = setButtonLoading(submitBtn, 'Signing in…');
    try {
      const user = await api.post('/auth/login', payload, { silent401: true });

      
      
      
      
      
      
      if (user.role === 'admin') {
        
        
        
        window.location.href = '/admin/applications.html';
        return;
      }

      redirectAfterLogin('/student/dashboard.html');
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
    } finally {
      restore();
    }
  });
}


function wireAdminLoginForm() {
  const form = document.getElementById('admin-login-form');
  if (!form) return;

  const alertBox = document.getElementById('form-alert');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    const payload = {
      email: form.email.value.trim(),
      password: form.password.value,
    };

    const restore = setButtonLoading(submitBtn, 'Signing in…');
    try {
      const user = await api.post('/auth/login', payload, { silent401: true });

      
      
      
      
      if (user.role !== 'admin') {
        await api.post('/auth/logout', undefined, { silent401: true }).catch(() => {});
        showAlert(alertBox, 'This is not an administrator account.', 'error');
        return;
      }

      redirectAfterLogin('/admin/applications.html');
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
    } finally {
      restore();
    }
  });
}


function redirectAfterLogin(defaultPath) {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  window.location.href = next ? decodeURIComponent(next) : defaultPath;
}
