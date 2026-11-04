"""Run the GFS and ECMWF archive downloads to the end. launchd starts it at boot and again after a failure."""
import download_ecmwf
import download_gfs

if __name__ == "__main__":
    download_ecmwf.main("2024-06-01")
    download_gfs.main("2021-01-01")
    print("all done", flush=True)
