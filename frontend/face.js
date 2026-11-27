/**
 * GeoFace — the browser half of face recognition.
 *
 * Loads face-api.js from a CDN on demand, then turns a camera frame into the same
 * 128-value face embedding the server expects. The image never leaves the device; only
 * the embedding (128 numbers) is posted, and the server decides whether it matches the
 * face on file. This is what makes recognition reliable where hashing raw pixels was not.
 *
 * Usage:
 *   await GeoFace.ready();                       // load engine + models (call once)
 *   const r = await GeoFace.describe(videoEl);   // { ok, descriptor } or { ok:false, reason }
 *   GeoFace.failureMessage(r.reason)             // human wording, mirrors the server
 */
(function () {
    'use strict';

    var VERSION = '1.7.15';
    var BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@' + VERSION + '/';
    var SCRIPT_URL = BASE + 'dist/face-api.js';
    var MODEL_URL = BASE + 'model/';

    var MESSAGES = {
        no_face: 'No face detected. Look straight at the camera in good light and keep your whole face in the frame.',
        invalid_face: 'No face detected. Look straight at the camera in good light and keep your whole face in the frame.',
        multiple_faces: 'More than one face is visible. Make sure only you are in front of the camera.',
        model_error: 'Face recognition could not start on this device. Check your connection and try again.',
        mismatch: 'That face did not match the one on file. Face the camera in good light and try again, or ask your admin to reset your face.'
    };

    var modelsPromise = null;

    function loadScript() {
        return new Promise(function (resolve, reject) {
            if (window.faceapi) { resolve(); return; }
            var script = document.createElement('script');
            script.src = SCRIPT_URL;
            script.async = true;
            script.onload = function () {
                window.faceapi ? resolve() : reject(new Error('face-api did not initialise'));
            };
            script.onerror = function () { reject(new Error('Could not load the face engine')); };
            document.head.appendChild(script);
        });
    }

    // Models are heavy (a few MB), so they are fetched once and cached for the page.
    function loadModels() {
        if (modelsPromise) return modelsPromise;
        modelsPromise = loadScript().then(function () {
            var api = window.faceapi;
            return Promise.all([
                api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
                api.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
                api.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
            ]);
        }).catch(function (error) {
            modelsPromise = null; // allow a later retry
            throw error;
        });
        return modelsPromise;
    }

    function detectorOptions() {
        return new window.faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });
    }

    // Runs detection + alignment + embedding over a <video>/<canvas>/<img>.
    async function describe(input) {
        var api = window.faceapi;
        if (!api) return { ok: false, reason: 'model_error' };
        var results = await api
            .detectAllFaces(input, detectorOptions())
            .withFaceLandmarks(true)
            .withFaceDescriptors();
        if (!results || results.length === 0) return { ok: false, reason: 'no_face' };
        if (results.length > 1) return { ok: false, reason: 'multiple_faces' };
        return {
            ok: true,
            descriptor: Array.prototype.slice.call(results[0].descriptor),
            score: results[0].detection.score
        };
    }

    window.GeoFace = {
        ready: loadModels,
        failureMessage: function (reason) {
            return MESSAGES[reason] || MESSAGES.mismatch;
        },
        describe: async function (input) {
            try {
                await loadModels();
                return await describe(input);
            } catch (error) {
                return { ok: false, reason: 'model_error', detail: String((error && error.message) || error) };
            }
        }
    };
})();
