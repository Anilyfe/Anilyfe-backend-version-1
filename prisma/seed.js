// prisma/seed.js
const { PrismaClient, Role, UserStatus } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = 'myanilyfe@gmail.com';
  const plainPassword = 'Anilyfe@Admin2026'; // change this if you want

  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      passwordHash,
    },
    create: {
      email,
      passwordHash,
      firstName: 'Anilyfe',
      lastName: 'Admin',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      country: 'Nigeria',
    },
  });

  console.log('✅ Admin created/updated:');
  console.log('   Email   :', admin.email);
  console.log('   Password:', plainPassword);
  console.log('   Role    :', admin.role);
  console.log('   Status  :', admin.status);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });