import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { AppConfig } from '../config/types'

/**
 * RAM per instance size suffix, in GiB (standard classes: t3/t4g/m5/m6g/r5...).
 * Only the suffixes this template can reasonably use are listed.
 */
const SIZE_MEMORY_GIB: Record<string, number> = {
  nano: 0.5,
  micro: 1,
  small: 2,
  medium: 4,
  large: 8,
  xlarge: 16,
  '2xlarge': 32,
  '3xlarge': 48,
  '4xlarge': 64,
  '6xlarge': 96,
  '8xlarge': 128,
  '12xlarge': 192,
  '16xlarge': 256,
  '24xlarge': 384,
  '32xlarge': 512,
}

/**
 * Approximate RAM of an instance type (`t3.small` -> 2). CDK cannot describe
 * instance memory, and host sizing must follow the instance instead of a
 * literal: a fixed 4 GB ClickHouse limit OOM-kills a 2 GB host.
 */
export function instanceMemoryGiB(instanceType: ec2.InstanceType): number {
  const size = instanceType.toString().split('.').pop() ?? ''
  const memory = SIZE_MEMORY_GIB[size]
  if (!memory) {
    throw new Error(
      `Unknown memory for instance type "${instanceType}". Add its size to SIZE_MEMORY_GIB in lib/host-image.ts.`,
    )
  }
  return memory
}

/**
 * Resolves Ubuntu through the public SSM parameter instead of pinning AMI IDs,
 * so the same config works in every region and stays current.
 */
export function ubuntuMachineImage(config: AppConfig): ec2.IMachineImage {
  const arch = config.hostImage.architecture === 'arm64' ? 'arm64' : 'amd64'
  return ec2.MachineImage.fromSsmParameter(
    `/aws/service/canonical/ubuntu/server/${config.hostImage.ubuntuVersion}/stable/current/${arch}/hvm/ebs-gp2/ami-id`,
    { os: ec2.OperatingSystemType.LINUX },
  )
}
