const app=require('./app');const prisma=require('./lib/prisma');const port=Number(process.env.PORT||4000);
const {startMaintenanceJobs}=require('./lib/maintenance');
const server=app.listen(port,()=>console.log(`Anilyfe API listening on http://localhost:${port}`));
if(process.env.MAINTENANCE_JOBS_ENABLED==='true'){
  startMaintenanceJobs({intervalMinutes:Number(process.env.MAINTENANCE_JOB_INTERVAL_MINUTES||10)});
  console.log('Maintenance jobs enabled.');
}
async function shutdown(){await prisma.$disconnect();server.close(()=>process.exit(0))}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
