/**
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

import FragmentModel from '../models/FragmentModel.js';
import FragmentController from './FragmentController.js';
import RepresentationController from '../../dash/controllers/RepresentationController.js';
import PlayList from '../vo/metrics/PlayList.js';
import ScheduleRulesCollection from '../rules/SchedulingRules/ScheduleRulesCollection.js';
import SwitchRequest from '../rules/SwitchRequest.js';
import FragmentRequest from '../vo/FragmentRequest.js';
import PlaybackController from './PlaybackController.js';
import AbrController from './AbrController.js';
import BufferController from './BufferController.js';
import TextController from './TextController.js';
import Stream from '../Stream.js';
import LiveEdgeFinder from '../LiveEdgeFinder.js';
import EventBus from '../utils/EventBus.js';
import Events from "../Events.js";

let ScheduleController = function () {
    "use strict";

    var fragmentsToLoad = 0,
        type,
        ready,
        fragmentModel,
        isDynamic,
        currentRepresentationInfo,
        initialPlayback = true,
        isStopped = false,
        playListMetrics = null,
        playListTraceMetrics = null,
        playListTraceMetricsClosed = true,
        isFragmentLoading = false,
        timeToloadDelay = 0,
        validateTimeout,
        seekTarget = NaN,

        clearPlayListTraceMetrics = function (endTime, stopreason) {
            var duration = 0,
                startTime = null;

            if (playListTraceMetricsClosed === false) {
                startTime = playListTraceMetrics.start;
                duration = endTime.getTime() - startTime.getTime();

                playListTraceMetrics.duration = duration;
                playListTraceMetrics.stopreason = stopreason;

                playListTraceMetricsClosed = true;
            }
        },

        doStart = function () {
            if (!ready) return;
            isStopped = false;
            if (initialPlayback) {
                initialPlayback = false;
            }
            this.log("start");
            //if starting from a pause we want to call validate to kick off the cycle that was stopped by pausing stream.
            if (this.playbackController.getPlayedRanges().length > 0) {
                validate.call(this);
            }
        },

        startOnReady = function() {
            if (initialPlayback) {
                getInitRequest.call(this, currentRepresentationInfo.quality);
                addPlaylistMetrics.call(this, PlayList.INITIAL_PLAY_START_REASON);
            }

            doStart.call(this);
        },

        doStop = function () {
            if (isStopped) return;
            isStopped = true;
            this.log("stop");
            clearInterval(validateTimeout);
            clearPlayListTraceMetrics(new Date(), PlayList.Trace.USER_REQUEST_STOP_REASON);
        },



        getInitRequest = function(quality) {
            var self = this,
                request;

            request = self.adapter.getInitRequest(self.streamProcessor, quality);

            if (request !== null) {
                fragmentModel.executeRequest(request);
            }

            return request;
        },



        replaceCanceledRequests = function(canceledRequests) {
            var ln = canceledRequests.length,
            // EPSILON is used to avoid javascript floating point issue, e.g. if request.startTime = 19.2,
            // request.duration = 3.83, than request.startTime + request.startTime = 19.2 + 1.92 = 21.119999999999997
                EPSILON = 0.1,
                request,
                time,
                i;

            for (i = 0; i < ln; i += 1) {
                request = canceledRequests[i];
                time = request.startTime + (request.duration / 2) + EPSILON;
                request = this.adapter.getFragmentRequestForTime(this.streamProcessor, currentRepresentationInfo, time, {timeThreshold: 0, ignoreIsFinished: true});
                fragmentModel.executeRequest(request);
            }
        },



        //*************************************************************************************
        //  START LOAD SYNC
        //*************************************************************************************

        validate = function () {
            if (isStopped || (this.playbackController.isPaused() && (this.playbackController.getPlayedRanges().length > 0) && !this.scheduleWhilePaused)) return;
            getRequiredFragmentCount.call(this, onGetRequiredFragmentCount.bind(this));
            //this.log("validate", type);
        },

        getRequiredFragmentCount = function(callback) {
            var self =this,
                rules = self.scheduleRulesCollection.getRules(ScheduleRulesCollection.prototype.FRAGMENTS_TO_SCHEDULE_RULES);

            self.rulesController.applyRules(rules, self.streamProcessor, callback, fragmentsToLoad, function(currentValue, newValue) {
                currentValue = currentValue === SwitchRequest.prototype.NO_CHANGE ? 0 : currentValue;
                return Math.max(currentValue, newValue);
            });
        },

        onGetRequiredFragmentCount = function(result) {
            var self = this;
            fragmentsToLoad = result.value;
            if (fragmentsToLoad > 0 && !self.bufferController.getIsAppendingInProgress() && !isFragmentLoading) {
                isFragmentLoading = true;
                this.abrController.getPlaybackQuality(this.streamProcessor,  getNextFragment.bind(self, onGetNextFragment.bind(self)));
            } else {
                validateTimeout = setTimeout(function(){
                    //self.log("timeout going back to validate")
                    validate.call(self);
                }, 1000); //TODO should this be something based on fragment duration?
            }
        },

        getNextFragment = function (callback) {
            var self =this,
                rules = self.scheduleRulesCollection.getRules(ScheduleRulesCollection.prototype.NEXT_FRAGMENT_RULES);

            self.rulesController.applyRules(rules, self.streamProcessor, callback, null, function(currentValue, newValue) {
                return newValue;
            });
        },

        onGetNextFragment = function(result) {
            if (result.value) {
                fragmentModel.executeRequest(result.value);
            }
        },

        onQualityChanged = function(e) {
            if (type !== e.mediaType || this.streamProcessor.getStreamInfo().id !== e.streamInfo.id) return;

            currentRepresentationInfo = this.streamProcessor.getRepresentationInfoForQuality(e.newQuality);
            if (currentRepresentationInfo === null || currentRepresentationInfo === undefined) {
                throw "Unexpected error! - currentRepresentationInfo is null or undefined";
            }

            clearPlayListTraceMetrics(new Date(), PlayList.Trace.REPRESENTATION_SWITCH_STOP_REASON);
        },

        onDataUpdateCompleted = function(e) {
            if (e.error) return;

            currentRepresentationInfo = this.adapter.convertDataToTrack(this.manifestModel.getValue(), e.currentRepresentation);
        },

        onStreamInitialized = function(e) {
            if (e.error) return;

            currentRepresentationInfo = this.streamProcessor.getCurrentRepresentationInfo();

            if (!isDynamic || this.liveEdgeFinder.getLiveEdge() !== null) {
                ready = true;
            }

            if (ready) {
                startOnReady.call(this);
            }
        },

        onStreamCompleted = function(e) {
            if (e.fragmentModel !== fragmentModel) return;
            this.log("Stream is complete");
            clearPlayListTraceMetrics(new Date(), PlayList.Trace.END_OF_CONTENT_STOP_REASON);
        },

        onFragmentLoadingCompleted = function (e) {
            if (e.sender !== fragmentModel) return;

            if (!isNaN(e.request.index)){
                isFragmentLoading = false;
            }
            if (!e.error) return;
            doStop.call(this);
        },

        onBytesAppended = function(e) {
            if (e.sender.streamProcessor !== this.streamProcessor) return;

            addPlaylistTraceMetrics.call(this);
            validate.call(this);
        },

        onDataUpdateStarted = function(e) {
            if (e.sender.streamProcessor !== this.streamProcessor) return;

            doStop.call(this);
        },

        onInitRequested = function(e) {
            if (e.sender.streamProcessor !== this.streamProcessor) return;

            getInitRequest.call(this, e.requiredQuality);
        },

        onBufferCleared = function(e) {
            if (e.sender.streamProcessor !== this.streamProcessor) return;
            // after the data has been removed from the buffer we should remove the requests from the list of
            // the executed requests for which playback time is inside the time interval that has been removed from the buffer
            fragmentModel.removeExecutedRequestsBeforeTime(e.to);

            if (e.hasEnoughSpaceToAppend && !this.bufferController.isBufferingCompleted()) {
                doStart.call(this);
            }
        },

        onBufferLevelStateChanged = function(e) {
            if ((e.sender.streamProcessor === this.streamProcessor) && e.state === BufferController.BUFFER_EMPTY && !this.playbackController.isSeeking()) {
                this.log("Stalling Buffer");
                clearPlayListTraceMetrics(new Date(), PlayList.Trace.REBUFFERING_REASON);
            }
        },

        onQuotaExceeded = function(e) {
            if (e.sender.streamProcessor !== this.streamProcessor) return;

            doStop.call(this);
        },

        addPlaylistMetrics = function(stopReason) {
            var currentTime = new Date(),
                presentationTime = this.playbackController.getTime();
            clearPlayListTraceMetrics(currentTime, PlayList.Trace.USER_REQUEST_STOP_REASON);
            playListMetrics = this.metricsModel.addPlayList(type, currentTime, presentationTime, stopReason);
        },

        addPlaylistTraceMetrics = function() {
            var self = this,
                currentVideoTime = self.playbackController.getTime(),
                rate = self.playbackController.getPlaybackRate(),
                currentTime = new Date();

            if (playListTraceMetricsClosed === true && currentRepresentationInfo && playListMetrics) {
                playListTraceMetricsClosed = false;
                playListTraceMetrics = self.metricsModel.appendPlayListTrace(playListMetrics, currentRepresentationInfo.id, null, currentTime, currentVideoTime, null, rate, null);
            }
        },

        onClosedCaptioningRequested = function(e) {
            getInitRequest.call(this, e.data.CCIndex);
        },

        onPlaybackStarted = function() {
            doStart.call(this);
        },

        onPlaybackSeeking = function(e) {

            if (!initialPlayback) {
                isFragmentLoading = false;
            }

            var metrics = this.metricsModel.getMetricsFor("stream"),
                manifestUpdateInfo = this.metricsExt.getCurrentManifestUpdate(metrics);

            seekTarget = e.seekTime;
            this.log("seek: " + seekTarget);
            addPlaylistMetrics.call(this, PlayList.SEEK_START_REASON);

            this.metricsModel.updateManifestUpdateInfo(manifestUpdateInfo, {latency: currentRepresentationInfo.DVRWindow.end - this.playbackController.getTime()});

            if (isDynamic){ // need to validate again for dynamic after first seek
                validate.call(this);
            }
        },

        onPlaybackRateChanged = function(/*e*/) {
            addPlaylistTraceMetrics.call(this);
        },

        onLiveEdgeSearchCompleted = function(e) {
            if (e.error) return;

            // step back from a found live edge time to be able to buffer some data
            var self = this,
                liveEdgeTime = e.liveEdge,
                manifestInfo = currentRepresentationInfo.mediaInfo.streamInfo.manifestInfo,
                startTime = liveEdgeTime - Math.min((self.playbackController.getLiveDelay(currentRepresentationInfo.fragmentDuration)), manifestInfo.DVRWindowSize / 2),
                request,
                metrics = self.metricsModel.getMetricsFor("stream"),
                manifestUpdateInfo = self.metricsExt.getCurrentManifestUpdate(metrics),
                currentLiveStart = self.playbackController.getLiveStartTime(),
                actualStartTime;
            // get a request for a start time
            request = self.adapter.getFragmentRequestForTime(self.streamProcessor, currentRepresentationInfo, startTime, {ignoreIsFinished: true});
            actualStartTime = request.startTime;

            if (isNaN(currentLiveStart) || (actualStartTime > currentLiveStart)) {
                self.playbackController.setLiveStartTime(actualStartTime);
            }

            self.metricsModel.updateManifestUpdateInfo(manifestUpdateInfo, {currentTime: actualStartTime, presentationStartTime: liveEdgeTime, latency: liveEdgeTime - actualStartTime, clientTimeOffset: self.timelineConverter.getClientTimeOffset()});

            ready = true;
            startOnReady.call(self);
        };



    return {
        log: undefined,
        system: undefined,
        metricsModel: undefined,
        manifestModel: undefined,
        metricsExt: undefined,
        scheduleWhilePaused: undefined,
        timelineConverter: undefined,
        abrController: undefined,
        playbackController: undefined,
        adapter: undefined,
        scheduleRulesCollection: undefined,
        rulesController: undefined,
        numOfParallelRequestAllowed:undefined,
        indexHandler:undefined,

        setup: function() {

            EventBus.on(Events.LIVE_EDGE_SEARCH_COMPLETED, onLiveEdgeSearchCompleted, this);
            EventBus.on(Events.QUALITY_CHANGED, onQualityChanged, this);
            EventBus.on(Events.DATA_UPDATE_STARTED, onDataUpdateStarted, this);
            EventBus.on(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
            EventBus.on(Events.FRAGMENT_LOADING_COMPLETED, onFragmentLoadingCompleted, this);
            EventBus.on(Events.STREAM_COMPLETED, onStreamCompleted, this);
            EventBus.on(Events.STREAM_INITIALIZED, onStreamInitialized, this);


            EventBus.on(Events.BUFFER_CLEARED, onBufferCleared, this);
            EventBus.on(Events.BYTES_APPENDED, onBytesAppended, this);
            EventBus.on(Events.INIT_REQUESTED, onInitRequested, this);
            EventBus.on(Events.QUOTA_EXCEEDED, onQuotaExceeded, this);
            EventBus.on(Events.BUFFER_LEVEL_STATE_CHANGED, onBufferLevelStateChanged, this);

            this[TextController.eventList.ENAME_CLOSED_CAPTIONING_REQUESTED] = onClosedCaptioningRequested;
            this[PlaybackController.eventList.ENAME_PLAYBACK_STARTED] = onPlaybackStarted;
            EventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);
            EventBus.on(Events.PLAYBACK_RATE_CHANGED, onPlaybackRateChanged, this);
        },

        initialize: function(typeValue, streamProcessor) {
            var self = this;
            type = typeValue;
            //self.setMediaType(type);
            self.streamProcessor = streamProcessor;
            self.fragmentController = streamProcessor.fragmentController;
            self.liveEdgeFinder = streamProcessor.liveEdgeFinder;
            self.bufferController = streamProcessor.bufferController;
            isDynamic = streamProcessor.isDynamic();
            fragmentModel = this.fragmentController.getModel(this);
            ScheduleController.LOADING_REQUEST_THRESHOLD = self.numOfParallelRequestAllowed;
        },

        getSeekTarget: function() {
            return seekTarget;
        },

        setSeekTarget: function(value) {
            seekTarget = value;
        },

        getFragmentModel: function() {
            return fragmentModel;
        },

        setTimeToLoadDelay: function(value){
            timeToloadDelay = value;
        },

        getTimeToLoadDelay: function(){
            return timeToloadDelay;
        },

        replaceCanceledRequests:replaceCanceledRequests,

        reset: function() {
            EventBus.off(Events.LIVE_EDGE_SEARCH_COMPLETED, onLiveEdgeSearchCompleted, this);
            EventBus.off(Events.DATA_UPDATE_STARTED, onDataUpdateStarted, this);
            EventBus.off(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
            EventBus.off(Events.BUFFER_LEVEL_STATE_CHANGED, onBufferLevelStateChanged, this);
            EventBus.off(Events.QUALITY_CHANGED, onQualityChanged, this);
            EventBus.off(Events.FRAGMENT_LOADING_COMPLETED, onFragmentLoadingCompleted, this);
            EventBus.off(Events.STREAM_COMPLETED, onStreamCompleted, this);
            EventBus.off(Events.STREAM_INITIALIZED, onStreamInitialized, this);
            EventBus.off(Events.QUOTA_EXCEEDED, onQuotaExceeded, this);
            EventBus.off(Events.BYTES_APPENDED, onBytesAppended, this);
            EventBus.off(Events.BUFFER_CLEARED, onBufferCleared, this);
            EventBus.off(Events.INIT_REQUESTED, onInitRequested, this);
            EventBus.off(Events.PLAYBACK_RATE_CHANGED, onPlaybackRateChanged, this);
            EventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);


            doStop.call(this);
            fragmentModel.abortRequests();
            this.fragmentController.detachModel(fragmentModel);
            isFragmentLoading = false;
            fragmentsToLoad = 0;
            timeToloadDelay = 0;
            seekTarget = NaN;
        },

        start: doStart,
        stop: doStop
    };
};

ScheduleController.prototype = {
    constructor: ScheduleController
};

ScheduleController.LOADING_REQUEST_THRESHOLD = 0;


export default ScheduleController;