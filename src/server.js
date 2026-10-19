const app=require('./app');const prisma=require('./lib/prisma');const port=Number(process.env.PORT||4000);
const server=app.listen(port,()=>console.log(`Anilyfe API listening on http://localhost:${port}`));
async function shutdown(){await prisma.$disconnect();server.close(()=>process.exit(0))}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
