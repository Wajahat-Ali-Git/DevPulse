import { PrismaClient, UserRole, RepositoryStatus } from '../src';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database with initial data...');

  const user = await prisma.user.upsert({
    where: { email: 'admin@devpulse.local' },
    update: {},
    create: {
      email: 'admin@devpulse.local',
      name: 'DevPulse Admin',
      role: UserRole.ADMIN,
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: 'devpulse-org' },
    update: {},
    create: {
      name: 'DevPulse Organization',
      slug: 'devpulse-org',
      members: {
        create: {
          userId: user.id,
          role: UserRole.ADMIN,
        },
      },
    },
  });

  await prisma.repository.upsert({
    where: { githubId: BigInt(12345678) },
    update: {},
    create: {
      workspaceId: workspace.id,
      name: 'DevPulse',
      fullName: 'DevPulse/DevPulse',
      githubId: BigInt(12345678),
      url: 'https://github.com/DevPulse/DevPulse',
      status: RepositoryStatus.ACTIVE,
    },
  });

  console.log('Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
