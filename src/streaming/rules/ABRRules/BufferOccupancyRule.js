﻿/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import SwitchRequest from '../SwitchRequest.js';
import BufferController from '../../controllers/BufferController.js';
import AbrController from '../../controllers/AbrController.js';

import FactoryMaker from '../../../core/FactoryMaker.js';
export default FactoryMaker.getClassFactory(BufferOccupancyRule);

function BufferOccupancyRule(config) {

    let log = config ? config.log : null,
        metricsModel = config ? config.metricsModel : null;

    let instance = {
        execute:execute,
        setConfig:setConfig,
        reset:reset
    }

    let lastSwitchTime = 0;

    return instance;

    function execute (context, callback) {
        var now = new Date().getTime()/1000,
            mediaInfo = context.getMediaInfo(),
            representationInfo = context.getTrackInfo(),
            mediaType = mediaInfo.type,
            waitToSwitchTime = !isNaN(representationInfo.fragmentDuration) ? representationInfo.fragmentDuration / 2 : 2,
            current = context.getCurrentValue(),
            streamProcessor = context.getStreamProcessor(),
            abrController = streamProcessor.getABRController(),
            metrics = metricsModel.getReadOnlyMetricsFor(mediaType),
            lastBufferLevelVO = (metrics.BufferLevel.length > 0) ? metrics.BufferLevel[metrics.BufferLevel.length - 1] : null,
            lastBufferStateVO = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null,
            isBufferRich = false,
            maxIndex = mediaInfo.representationCount - 1,
            switchRequest = new SwitchRequest(SwitchRequest.prototype.NO_CHANGE, SwitchRequest.prototype.WEAK);

        if (now - lastSwitchTime < waitToSwitchTime ||
            abrController.getAbandonmentStateFor(mediaType) === abrController.ABANDON_LOAD) {
            callback(switchRequest);
            return;
        }

        if (lastBufferLevelVO !== null && lastBufferStateVO !== null) {
            // This will happen when another rule tries to switch from top to any other.
            // If there is enough buffer why not try to stay at high level.
            if (lastBufferLevelVO.level > lastBufferStateVO.target) {
                isBufferRich = (lastBufferLevelVO.level - lastBufferStateVO.target) > BufferController.RICH_BUFFER_THRESHOLD;
                if (isBufferRich && mediaInfo.representationCount > 1) {
                    switchRequest = new SwitchRequest(maxIndex, SwitchRequest.prototype.STRONG);
                }
            }
        }

        if (switchRequest.value !== SwitchRequest.prototype.NO_CHANGE && switchRequest.value !== current) {
            log("BufferOccupancyRule requesting switch to index: ", switchRequest.value, "type: ",mediaType, " Priority: ",
                switchRequest.priority === SwitchRequest.prototype.DEFAULT ? "Default" :
                    switchRequest.priority === SwitchRequest.prototype.STRONG ? "Strong" : "Weak");
        }

        callback(switchRequest);
    }

    function reset() {
        lastSwitchTime = 0;
    }

    function setConfig(config){
        if (!config) return;
        if (config.log){
            log = config.log;
        }
        if (config.metricsModel){
            metricsModel = config.metricsModel;
        }
    }
};