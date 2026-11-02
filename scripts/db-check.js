const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const users = await prisma.user.findMany({
    select: {
      id: true, email: true, firstName: true, lastName: true,
      role: true, status: true, emailVerifiedAt: true, createdAt: true,
      seller: { select: { id: true, businessName: true, storeStatus: true, category: true } }
    },
    orderBy: { createdAt: 'asc' }
  });
  console.log('--- users ---');
  for (const u of users) {
    const sellerBit = u.seller ? ` [seller: ${u.seller.businessName} (${u.seller.storeStatus}) cat=${u.seller.category}]` : '';
    console.log(`${u.role} | ${u.status} | ${u.email} | ${u.firstName} ${u.lastName} | verified=${!!u.emailVerifiedAt}${sellerBit}`);
  }

  console.log('--- sellers ---');
  const sellers = await prisma.seller.findMany({ include: { user: { select: { email: true } } } });
  for (const s of sellers) {
    console.log(JSON.stringify({ id: s.id, businessName: s.businessName, storeStatus: s.storeStatus, email: s.user.email, commission: s.commissionRate, verification: s.verificationStatus }, null, 0));
  }

  console.log('--- admin applications ---');
  try {
    const apps = await prisma.adminApplication.findMany({ include: { user: { select: { email: true } } } });
    for (const a of apps) console.log(JSON.stringify({ status: a.status, email: a.user.email, requestedRole: a.requestedRole ?? null }));
    if (!apps.length) console.log('(none)');
  } catch (e) {
    console.log('query failed:', e.message.split('\n')[0]);
  }
  await prisma.$disconnect();
})();
