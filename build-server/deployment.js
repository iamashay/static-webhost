import Docker from 'dockerode';
import {withTimeout, Semaphore} from 'async-mutex'
import {DeploymentError, DockerError}  from './error.js'
import path from 'path'
import fs from 'fs'
import {updateDeploymentStatus, StreamLogger, getGitDetails, getUserRepoName} from './lib.js'
import { uploadFiles } from './S3.js';
import { logger } from './logger.js';

const {DOCKER_HOST, DOCKER_PORT, DOCKER_PROTOCOL, DOCKER_VERSION, BUILD_PATH} = process.env
const MAX_UPTIME = 300
const DOCKER_LIMIT = 2
const docker = new Docker({
    protocol: DOCKER_PROTOCOL, 
    host: DOCKER_HOST, 
    port: DOCKER_PORT,
    version: DOCKER_VERSION
});

const {MAX_GIT_SIZE} = process.env


const assignDockerInstanceMutex = withTimeout(new Semaphore(2), 300000, new DockerError('Waiting for docker timedout'))
//console.log(deleteContainerMutex)


const deleteUnusableContainers = async  () => {
    //deletes containers if they are exited or up for more than 2 minutes
    try {
        const listContainers = await getContainersByImage({image: "build-image"})
        for (const container of listContainers){
            const uptime = Math.floor((+new Date() / 1000) - container.Created)
            const {Id, State} = container
            //console.log(uptime)
            const dockerContainer = docker.getContainer(Id)
            //console.log(listContainers)
            if (State == 'running' && uptime > MAX_UPTIME) {
                await dockerContainer.remove({force: true})
                //console.log(`Time exceeded (${uptime}s) ${Id} deleted!`)
                logger.info(`Time exceeded (${uptime}s) ${Id} deleted!`)
            } else if (State == 'running') {
                // console.log(`${Id} is running since ${uptime}s!`)
                logger.info(`${Id} is running since ${uptime}s!`)
            } else if (State != 'removing') {
                await dockerContainer.remove({force: true})
                console.log(`Removed ${Id} of ${State} status!`)
                logger.info(`Removed ${Id} of ${State} status!`)
            } else {
                logger.error(`Unknown ${Id} with ${State} found`)
    
            }
        }
    } catch (e) {
        // console.log("Error deleting the containers"+e)
        logger.error("Error deleting the containers"+e)
        throw e
    }
} 

//deleteUnusableContainers()

async function initiateContainer({gitURL, image, projectId, buildScript, localOutLogger}) {
    const outStream = new StreamLogger(localOutLogger, "info", "console")
    const errStream = new StreamLogger(localOutLogger, "error", "console")

    try {
    const sourcePath = path.join(BUILD_PATH, projectId)
    const targetPath = path.posix.join('/', 'home', 'app', 'output')
    const projectBuildCmd = 'npm run '+buildScript
    await fs.promises.rm(sourcePath, { maxRetries: 2, retryDelay: 2000, recursive: true, force: true })
    await fs.promises.mkdir(sourcePath, {recursive: true})
    let containerCMD;
    if(image === 'static-image') {
        containerCMD = [
            'bash', 
            '-c',
            `git clone ${gitURL} ${targetPath} && echo "Downloaded project from git"`
        ]
    } else {
        containerCMD = [
            'bash', 
            '-c',
            `git clone --quiet ${gitURL} ${targetPath} && echo "Downloaded project from git" && npm config set update-notifier false && npm --loglevel=error i && echo "NPM package installed!" && ${projectBuildCmd} && echo "Project Built Successfully"`
        ]
    }
    const container = await docker.run(image, 
        containerCMD
        , 
    [outStream, errStream], {
            //Env,
            Tty: false,
            HostConfig: {
                Memory: 6e+8,
                AutoRemove: true,
                Mounts: [
                  {
                    Type: 'bind',
                    Source: sourcePath,
                    Target: targetPath,
                    ReadOnly: false,
                  },
                ],
                DiskQuota: 1,
            },
        },
    )
    return {container}
    } finally {

    }
}

//initiateContainer({Env: ["GIT_REPOSITORY_URL=https://github.com/iamashay/ShoppingApp.git"], image: 'build-image'})

const getContainersByImage = async ({image}) => {
    
    try {
        const listContainers =  await docker.listContainers({ 
            all: true, 
            filters: JSON.stringify({ancestor: [image]})
        })
        return listContainers
    } catch (e) {
        // console.error(`Error getting list of containers ${e}`)
        logger.error(`Error getting list of containers ${e}`)
        throw e
    } 
    
}



export const deployProject = async ({deploymentId, gitURL, image, Env, projectId, slug, buildFolder, buildScript, localOutLogger}) => {

    //if (assignDockerInstanceMutex.getValue() <= 0) throw new DockerError("No docker instance available for use!")
    await assignDockerInstanceMutex.acquire()
    await updateDeploymentStatus({id: deploymentId, status: 'Building'})
    try {
        await deleteUnusableContainers()
        const containerList = await getContainersByImage({image})
        if (containerList.length >= DOCKER_LIMIT) throw new DockerError(`Limit error, more than ${DOCKER_LIMIT} are on use`)
        //console.log(containerList)
        // console.log("Creating a container for "+gitURL)
        logger.info("Creating a container for "+gitURL)
        const [userName, repoName] = getUserRepoName(gitURL);
        //console.log(userName, repoName)
        const getDetails = await getGitDetails(userName, repoName);
        if (getDetails?.size > MAX_GIT_SIZE) throw Error("Repo is too large!");
        const {container, iniOutputLog, iniErrLog} = await initiateContainer({gitURL, image, Env, projectId, buildScript, localOutLogger})

        if (!container) throw new Error("No container exists")
        
        if (container[0].StatusCode != 0) throw new DeploymentError(`Container exited with ${container[0].StatusCode}`)
        await updateDeploymentStatus({id: deploymentId, status: 'Built'})
        await uploadFiles({projectId, slug, buildFolder, localOutLogger})
        await updateDeploymentStatus({id: deploymentId, status: 'Deployed'})
        //console.log(`Installation ID: ${container[1].id}`)
        return true
    }  finally {
        assignDockerInstanceMutex.release()
    }

}
