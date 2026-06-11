import { describe, expect, it } from "vitest";
import { downsampleTo16kPcm16 } from "./useMicPcmStream";

describe("downsampleTo16kPcm16", () => {
  it("identity: 16k input returns same number of samples as Int16Array", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const result = downsampleTo16kPcm16(input, 16000);
    expect(result).toBeInstanceOf(Int16Array);
    // At 16k -> 16k, length should equal input length
    expect(result.length).toBe(input.length);
  });

  it("identity: 16k values are correctly scaled to Int16", () => {
    const input = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const result = downsampleTo16kPcm16(input, 16000);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(32767);
    expect(result[2]).toBe(-32768);
    // 0.5 * 32767 = 16383.5 -> floor -> 16383
    expect(result[3]).toBe(Math.floor(0.5 * 32767));
    // -0.5 * 32768 = -16384
    expect(result[4]).toBe(Math.floor(-0.5 * 32768));
  });

  it("48k -> 16k: output length equals ceil(inputLen / 3)", () => {
    // 48k / 16k = 3 ratio
    const input = new Float32Array(48000); // 1 second at 48k
    const result = downsampleTo16kPcm16(input, 48000);
    expect(result.length).toBe(Math.ceil(input.length / 3));
  });

  it("48k -> 16k: non-multiple length uses ceil", () => {
    // 10 samples at 48k -> ceil(10/3) = 4 output samples
    const input = new Float32Array(10);
    const result = downsampleTo16kPcm16(input, 48000);
    expect(result.length).toBe(Math.ceil(10 / 3));
  });

  it("clipping: values above 1 are clamped to Int16 max", () => {
    const input = new Float32Array([2.0, 1.5, 1.0]);
    const result = downsampleTo16kPcm16(input, 16000);
    // All should be clamped to max positive
    expect(result[0]).toBe(32767);
    expect(result[1]).toBe(32767);
    expect(result[2]).toBe(32767);
  });

  it("clipping: values below -1 are clamped to Int16 min", () => {
    const input = new Float32Array([-2.0, -1.5, -1.0]);
    const result = downsampleTo16kPcm16(input, 16000);
    expect(result[0]).toBe(-32768);
    expect(result[1]).toBe(-32768);
    expect(result[2]).toBe(-32768);
  });

  it("empty input returns empty Int16Array", () => {
    const input = new Float32Array(0);
    const result = downsampleTo16kPcm16(input, 16000);
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(0);
  });

  it("empty input at non-16k rate returns empty Int16Array", () => {
    const input = new Float32Array(0);
    const result = downsampleTo16kPcm16(input, 48000);
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(0);
  });

  it("44.1k -> 16k: length is ceil(inputLen * 16000 / 44100)", () => {
    const inputLen = 441; // 10ms at 44.1k
    const input = new Float32Array(inputLen);
    const result = downsampleTo16kPcm16(input, 44100);
    const expected = Math.ceil((inputLen * 16000) / 44100);
    expect(result.length).toBe(expected);
  });
});
