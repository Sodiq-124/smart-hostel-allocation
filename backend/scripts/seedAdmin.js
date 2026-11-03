

require('dotenv').config();

const bcrypt = require('bcrypt');
const readline = require('readline');
const { pool, queryOne, query } = require('../config/database');

const BCRYPT_ROUNDS = 12;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function isPasswordStrong(password) {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

async function main() {
  console.log('\n  LASU Smart Hostel — administrator seed');
  console.log('  ----------------------------------------------');

  let { SEED_ADMIN_NAME: name, SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = process.env;

  if (!name || !email || !password) {
    console.log('  One or more SEED_ADMIN_* variables are missing from .env.');
    name = name || (await ask('  Full name: '));
    email = email || (await ask('  Email: '));
    password = password || (await ask('  Password (min 8 chars, letters + numbers): '));
  }

  if (!isPasswordStrong(password)) {
    console.error('\n  Refusing to continue: the password must be at least 8 characters');
    console.error('  and contain both a letter and a number.');
    process.exitCode = 1;
    return;
  }

  const existing = await queryOne(
    `SELECT id, role FROM users WHERE email = ?`,
    [email]
  );

  if (existing && existing.role !== 'admin') {
    console.error(`\n  A non-admin account already uses ${email}. Choose a different email.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  if (existing) {
    await query(
      `UPDATE users SET full_name = ?, password = ? WHERE id = ?`,
      [name, passwordHash, existing.id]
    );
    console.log(`\n  Updated existing admin account: ${email} (id ${existing.id})`);
  } else {
    
    
    
    const result = await query(
      `INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, 'admin')`,
      [name, email, passwordHash]
    );
    console.log(`\n  Created new admin account: ${email} (id ${result.insertId})`);
  }

  console.log('  You can now log in at /admin/login.html');
  console.log('  ----------------------------------------------\n');
}

main()
  .catch((error) => {
    console.error('\n  Seeding failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
