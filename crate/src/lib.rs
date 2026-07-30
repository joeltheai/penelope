use wasm_bindgen::prelude::*;

/// Stateful CPU-side stroke resampler.
///
/// Pointer events arrive at uneven intervals. A stamp brush needs evenly spaced
/// dabs, so this turns packed `[x, y, pressure, ...]` samples into packed dabs
/// while preserving spacing across calls.
#[wasm_bindgen]
pub struct StrokeResampler {
    initialized: bool,
    last_x: f32,
    last_y: f32,
    last_pressure: f32,
    distance_to_next: f32,
}

#[wasm_bindgen]
impl StrokeResampler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            initialized: false,
            last_x: 0.0,
            last_y: 0.0,
            last_pressure: 0.0,
            distance_to_next: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.initialized = false;
        self.distance_to_next = 0.0;
    }

    pub fn push(&mut self, samples: &[f32], spacing: f32) -> Vec<f32> {
        let spacing = spacing.max(0.25);
        let mut dabs = Vec::with_capacity(samples.len());

        for sample in samples.chunks_exact(3) {
            let target_x = sample[0];
            let target_y = sample[1];
            let target_pressure = sample[2].clamp(0.0, 1.0);

            if !self.initialized {
                self.initialized = true;
                self.last_x = target_x;
                self.last_y = target_y;
                self.last_pressure = target_pressure;
                self.distance_to_next = spacing;
                dabs.extend_from_slice(&[target_x, target_y, target_pressure]);
                continue;
            }

            let mut start_x = self.last_x;
            let mut start_y = self.last_y;
            let mut start_pressure = self.last_pressure;
            let mut dx = target_x - start_x;
            let mut dy = target_y - start_y;
            let mut segment_length = dx.hypot(dy);

            while segment_length >= self.distance_to_next {
                let t = self.distance_to_next / segment_length;
                start_x += dx * t;
                start_y += dy * t;
                start_pressure += (target_pressure - start_pressure) * t;
                dabs.extend_from_slice(&[start_x, start_y, start_pressure]);

                dx = target_x - start_x;
                dy = target_y - start_y;
                segment_length = dx.hypot(dy);
                self.distance_to_next = spacing;
            }

            self.distance_to_next -= segment_length;
            self.last_x = target_x;
            self.last_y = target_y;
            self.last_pressure = target_pressure;
        }

        dabs
    }
}

impl Default for StrokeResampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_evenly_spaced_dabs_across_calls() {
        let mut resampler = StrokeResampler::new();

        assert_eq!(resampler.push(&[0.0, 0.0, 0.5], 2.0), [0.0, 0.0, 0.5]);
        assert_eq!(resampler.push(&[3.0, 0.0, 0.5], 2.0), [2.0, 0.0, 0.5]);
        assert_eq!(resampler.push(&[5.0, 0.0, 0.5], 2.0), [4.0, 0.0, 0.5]);
    }
}
