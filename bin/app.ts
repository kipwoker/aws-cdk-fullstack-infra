#!/usr/bin/env node
import { App } from 'aws-cdk-lib'
import { assembleStacks } from '../lib/app'

const app = new App()
assembleStacks(app)
