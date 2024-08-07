import {queueClient} from './queue/queueClient.js'
import 'dotenv/config'
import {deployProject} from'./deployment.js'
import {DockerError, DeploymentError} from './error.js'
import { createDeployement, updateDeploymentStatus, uploadDeploymentLog, StreamLogger, checkLatestDeployment } from './lib.js'
import { StringLogger, logger } from './logger.js'

const BUILDQUEUE = process.env.BUILDQUEUE;

const queueSys = async () => {
  const conn = await queueClient()
  const ch1 = await conn.createChannel();
  await ch1.assertQueue(BUILDQUEUE);

  // Listener
  ch1.consume(BUILDQUEUE, async (msg) => {
    if (msg !== null) {
      const data = msg.content.toString()
      logger.info('Recieved a deployment link: '+data);
      // console.log(msg)
      //ch1.ack(msg);
      let deploymentId;
      const [localOutLogger, outputLog] = StringLogger()
      try {
        const project = JSON.parse(data)
        const {gitURL, id, slug, projectType} = project
        let { buildFolder, buildScript } = project
        let image;
        if (projectType === 'Static') {
          buildFolder = './'
          image = 'static-image'
        } else if (projectType === 'React') {
          image = 'react-image'
        }
        //console.log(buildFolder)
        //const newDeployment = await createDeployement({id, buildFolder, buildScript})
        deploymentId = project.deploymentId
        //console.log("Initiated deployment: "+deploymentId)
        logger.info("Deployment ID: "+deploymentId)
        await checkLatestDeployment({deploymentId, projectId: id})
        const deployInstance = await deployProject({gitURL, id, slug, projectId: id, buildFolder, buildScript, deploymentId, localOutLogger, image})
        //console.log(initiatePool)
        ch1.ack(msg)
      } catch(err){
        localOutLogger.error("Deployment Halted")
        console.log("Halt error: "+ err)

        if (err.code === "ECONNREFUSED") {
          if (deploymentId) await updateDeploymentStatus({id: deploymentId, status: "Error"})
          localOutLogger.error("Connection error: ECONNREFUSED")
          return
        }
        localOutLogger.error(err.message)
        if (err instanceof DockerError) {
          if (deploymentId) await updateDeploymentStatus({id: deploymentId, status: "Error"})
          return
        } else if (err instanceof DeploymentError) {
          console.error(err)
          if (deploymentId) await updateDeploymentStatus({id: deploymentId, status: "Error"})
          ch1.reject(msg, false)
          return
        }

        ch1.reject(msg, false)
        if (deploymentId) await updateDeploymentStatus({id: deploymentId, status: "Error"})
      } finally {
        //console.log(containerErrLog, containerOutputLog)
        // containerOutputLog.end()
        // containerErrLog.end()
        if (deploymentId) uploadDeploymentLog({deployment: deploymentId, outputLog: outputLog.getLogString()})
      }
      
      //console.log('Consumer cancelled by server');
    }
  }, {
    noAck: false
  });
  
}


queueSys()