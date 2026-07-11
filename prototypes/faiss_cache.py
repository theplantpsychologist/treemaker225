# =============================================================================
# build_faiss_cache.py (Run whenever updating databases or query parameters)
# =============================================================================
import os
import pickle
import sqlite3
import numpy as np
import matplotlib.pyplot as plt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database.tilings.build_tilings import Tiling # Import your actual model
from src.engine.tree import extract_eigenvalues, EIG_COUNT, RESOLUTION

DIMENSION = 64
E_MIN = 3.0
E_MAX = 10.0
E_SWEEP = np.linspace(E_MIN, E_MAX, DIMENSION)
TWO_VARIANCE = 2.0 * ( (2*((E_MAX - E_MIN) / (DIMENSION - 1))) ** 2)

def compute_wks_signature(eigenvalues, dim=DIMENSION):
    """ 
    Converts raw eigenvalues to a Mass-Normalized Cumulative Wave Kernel Signature (CWKS CDF). 
    """
    is_1d = eigenvalues.ndim == 1
    if is_1d:
        eigenvalues = eigenvalues.reshape(1, -1)
        
    N_samples = eigenvalues.shape[0]
    signatures = np.zeros((N_samples, dim), dtype=np.float32)
    
    valid_mask = eigenvalues > 1e-6
    safe_eigs = np.where(valid_mask, eigenvalues, 1.0) 
    log_eigs = np.log(safe_eigs)
    
    for j, e in enumerate(E_SWEEP):
        squared_diff = (e - log_eigs) ** 2
        band_pass = np.exp(-squared_diff / TWO_VARIANCE)
        band_pass = np.where(valid_mask, band_pass, 0.0)
        signatures[:, j] = np.sum(band_pass, axis=1)
    
    # Convert PDF to CDF
    cumulative = np.cumsum(signatures, axis=1)
    
    # Normalize by Total Spectral Mass (Forces the final bucket to 1.0)
    # This isolates the proportional shape of the tree and ignores raw node count
    row_max = cumulative[:, -1:]
    row_max[row_max == 0] = 1.0
    cdf = cumulative / row_max
    
    if is_1d: return cdf[0]
    return cdf
