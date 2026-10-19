// Create/update the deployment administrator from environment variables only.
// Never keep an administrator password in source or print credentials to logs.
require('dotenv').config();
const { PrismaClient, Role, UserStatus } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const plainPassword = process.env.ADMIN_PASSWORD || '';
  if (!email || !plainPassword) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment before running the admin seed.');
  }
  if (plainPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  }

  const passwordHash = await bcrypt.hash(plainPassword, 12);
  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE, passwordHash },
    create: {
      email,
      passwordHash,
      firstName: 'AniLife',
      lastName: 'Admin',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      country: 'Nigeria',
    },
  });

  console.log(`Administrator is ready: ${admin.email} (${admin.role}, ${admin.status}).`);
}

main()
  .catch((error) => {
    console.error('Admin seed failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
