import * as tf from '@spotify/basic-pitch/node_modules/@tensorflow/tfjs';
import { BasicPitch, noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly } from '@spotify/basic-pitch';
import { Midi } from '@tonejs/midi';
window.PianoVendor = { tf, BasicPitch, noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly, Midi };
